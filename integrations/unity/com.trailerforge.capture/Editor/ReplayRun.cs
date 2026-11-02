using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.AI;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace TrailerForge.Capture.Editor
{
    public enum ReplayCamera
    {
        /// <summary>The game camera as it moved while you played.</summary>
        Recorded,
        /// <summary>A camera you placed, found by its tag; it keeps its own position or animation.</summary>
        Tagged,
        /// <summary>The main camera is left free, so a Cinemachine Brain (or your own rig) drives it.</summary>
        LiveMainCamera,
    }

    /// <summary>One way of filming a performance again: which camera, HUD, speed, size, frame rate.</summary>
    [Serializable]
    public class ReplayPass
    {
        public ReplayCamera Camera = ReplayCamera.Recorded;
        public string CameraTag = "";
        public bool Hud;
        /// <summary>1 = as played, 0.5 = half speed. Between 0.05 and 1.</summary>
        public float Speed = 1;
        public int Width = 1920;
        public int Height = 1080;
        public int Fps = 60;
        public TakeFormat Format = TakeFormat.ProRes422HQ;
        /// <summary>Turn off the game's own scripts so nothing but the performance moves.</summary>
        public bool FreezeScripts = true;

        public string CameraLabel =>
            Camera == ReplayCamera.Recorded ? "recorded" : Camera == ReplayCamera.Tagged ? (CameraTag.Length > 0 ? CameraTag : "tagged") : "live main";
    }

    /// <summary>Makes one camera the only "MainCamera" (what Unity Recorder films) and puts the tags back afterwards.</summary>
    public class CameraSwap
    {
        readonly List<(Camera cam, string tag)> saved = new List<(Camera, string)>();

        public void Isolate(Camera cam)
        {
            foreach (var other in Object.FindObjectsOfType<Camera>(true))
                if (other != cam && other.CompareTag("MainCamera")) { saved.Add((other, other.tag)); other.tag = "Untagged"; }
            saved.Add((cam, cam.tag));
            cam.tag = "MainCamera";
        }

        public void Restore()
        {
            foreach (var (cam, tag) in saved) if (cam != null) cam.tag = tag;
            saved.Clear();
        }
    }

    /// <summary>
    /// Films a recorded performance again (level 4b). The scene is loaded fresh, the game is frozen (rigidbodies
    /// kinematic; Animators, NavMeshAgents, CharacterControllers and, by default, game scripts off), and every frame,
    /// after anything else could move, each object is put where the performance says: exactly on a recorded frame,
    /// interpolated between two (position lerp, rotation slerp) in slow motion. Time runs at a locked frame rate and
    /// is scaled by the speed, so particles and shaders slow down with it. The result is a normal take with a sidecar.
    /// </summary>
    public class ReplayRun
    {
        public static ReplayRun Current { get; private set; }

        public Performance Performance { get; }
        public ReplayPass Pass { get; }
        public TakeRequest Request { get; }
        public TakeState State { get; private set; } = TakeState.Recording;
        public string Error { get; private set; }
        public List<string> Warnings { get; } = new List<string>();
        public ShotRecorder Recorder { get; private set; }
        /// <summary>Raised after the poses of a replay frame were applied (frame index, performance time).</summary>
        public event Action<int, double> Applied;
        public event Action<ReplayRun> Done;

        readonly bool reloadScenes;
        readonly Dictionary<int, Transform> bound = new Dictionary<int, Transform>();
        readonly Dictionary<int, PerfObject> defs = new Dictionary<int, PerfObject>();
        readonly HashSet<int> released = new HashSet<int>();
        readonly HashSet<Renderer> known = new HashSet<Renderer>();
        readonly CameraSwap cameras = new CameraSwap();
        Routine routine;
        int next;
        int eventIndex;
        bool running;
        int savedCaptureRate;
        float savedTimeScale = 1;
        bool recorderDone;

        public Transform Bound(int objectId) => bound.TryGetValue(objectId, out var t) ? t : null;

        public static ReplayRun Start(Performance performance, ReplayPass pass, TakeRequest request, bool reloadScenes = true)
        {
            if (!Application.isPlaying) throw new InvalidOperationException("Enter Play Mode first: a performance is filmed again while the game runs.");
            if (Current != null && Current.State == TakeState.Recording) throw new InvalidOperationException("A replay is already running.");
            if (performance.Frames.Count == 0) throw new InvalidOperationException("This performance has no frames.");
            if (pass.Speed <= 0.049f || pass.Speed > 1.0001f) throw new InvalidOperationException("Speed must be between 0.05 and 1.");
            var run = new ReplayRun(performance, pass, request, reloadScenes);
            Current = run;
            run.routine = new Routine(run.Steps());
            EditorApplication.update += run.Tick;
            EditorApplication.playModeStateChanged += run.OnPlayMode;
            run.Tick();
            return run;
        }

        ReplayRun(Performance performance, ReplayPass pass, TakeRequest request, bool reloadScenes)
        {
            Performance = performance;
            Pass = pass;
            this.reloadScenes = reloadScenes;
            foreach (var o in performance.Objects) defs[o.Id] = o;
            Request = request;
            request.Width = pass.Width;
            request.Height = pass.Height;
            request.Fps = pass.Fps;
            request.Hud = pass.Hud;
            request.Format = pass.Format;
            request.Level = "replay";
            request.Speed = pass.Speed;
            request.PerformanceId = performance.Meta.id;
            request.CameraLabel = pass.CameraLabel;
            request.CameraTag = "";
            request.Audio = Math.Abs(pass.Speed - 1) < 1e-6;
            request.Seconds = performance.Seconds / pass.Speed;
            if (string.IsNullOrEmpty(request.Code)) request.Code = performance.Meta.code;
        }

        IEnumerator Steps()
        {
            if (reloadScenes) yield return LoadScenes();
            Bind();
            Freeze();
            if (Pass.Camera == ReplayCamera.Tagged)
            {
                GameObject go;
                try { go = GameObject.FindWithTag(Pass.CameraTag); }
                catch (UnityException) { throw new InvalidOperationException($"The tag \"{Pass.CameraTag}\" does not exist."); }
                var cam = go != null ? go.GetComponent<Camera>() : null;
                if (cam == null) throw new InvalidOperationException($"No camera tagged \"{Pass.CameraTag}\" in the scene.");
                cameras.Isolate(cam);
            }
            if (Pass.Camera != ReplayCamera.Recorded)
                foreach (var d in defs.Values.Where(d => d.IsCamera)) released.Add(d.Id);

            savedCaptureRate = Time.captureFramerate;
            savedTimeScale = Time.timeScale;
            Time.captureFramerate = Pass.Fps;
            Time.timeScale = Pass.Speed;
            next = 0;
            Apply(0);
            running = true;
            LateHook.Add(OnLate);
            Recorder = ShotRecorder.Start(Request);
            recorderDone = Recorder.State != TakeState.Recording;
            Recorder.Done += _ => recorderDone = true;
            while (!recorderDone) yield return null;
        }

        IEnumerator LoadScenes()
        {
            var scenes = Performance.Meta.scenes.Where(s => !string.IsNullOrEmpty(s)).ToList();
            if (scenes.Count == 0)
            {
                Warnings.Add("The performance was captured in an unsaved scene; it is replayed in the scene that is open.");
                yield break;
            }
            for (var i = 0; i < scenes.Count; i++)
            {
                if (AssetDatabase.LoadAssetAtPath<SceneAsset>(scenes[i]) == null)
                    throw new InvalidOperationException($"The scene {scenes[i]} of this performance no longer exists.");
                yield return EditorSceneManager.LoadSceneAsyncInPlayMode(scenes[i], new LoadSceneParameters(i == 0 ? LoadSceneMode.Single : LoadSceneMode.Additive));
            }
            yield return null;
        }

        // ---- binding the performance to the scene ----------------------------------------------------------------

        void Bind()
        {
            var byPath = new Dictionary<string, Transform>();
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects())
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                    byPath[PerformanceCapture.ScenePath(t)] = t;
            }
            var missing = 0;
            foreach (var d in Performance.Objects.OrderBy(o => o.Id))
            {
                Transform t = null;
                switch (d.Kind)
                {
                    case PerfObjectKind.Scene:
                        byPath.TryGetValue(d.Path, out t);
                        break;
                    case PerfObjectKind.StandIn:
                        t = MakeStandIn(d);
                        break;
                    case PerfObjectKind.Prefab:
                        t = MakePrefab(d);
                        break;
                    case PerfObjectKind.PrefabPart:
                        if (bound.TryGetValue(d.Parent, out var root)) t = FindRelative(root, d.Path);
                        break;
                }
                if (t == null) { if (d.Kind != PerfObjectKind.StandIn && d.Kind != PerfObjectKind.Prefab) missing++; continue; }
                bound[d.Id] = t;
            }
            if (missing > 0) Warnings.Add($"{missing} object(s) of the performance are not in the scene any more (renamed or moved since the capture); they stay still.");
            foreach (var r in Object.FindObjectsByType<Renderer>(FindObjectsInactive.Include, FindObjectsSortMode.None)) known.Add(r);
        }

        static Transform FindRelative(Transform root, string path)
        {
            var t = root;
            foreach (var part in path.Split('/'))
            {
                var open = part.LastIndexOf('[');
                var name = open > 0 ? part.Substring(0, open) : part;
                int.TryParse(open > 0 ? part.Substring(open + 1).TrimEnd(']') : "-1", out var index);
                Transform hit = null;
                if (index >= 0 && index < t.childCount && t.GetChild(index).name == name) hit = t.GetChild(index);
                else for (var i = 0; i < t.childCount && hit == null; i++) if (t.GetChild(i).name == name) hit = t.GetChild(i);
                if (hit == null) return null;
                t = hit;
            }
            return t;
        }

        Transform MakeStandIn(PerfObject d)
        {
            var mesh = LoadById<Mesh>(d.Mesh);
            if (mesh == null) { Warnings.Add($"The mesh of \"{d.Path}\" was not found; it is left out of the replay."); return null; }
            var go = new GameObject(d.Path + " (replay)");
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            go.AddComponent<MeshRenderer>().sharedMaterials = d.Materials.Select(LoadById<Material>).ToArray();
            go.SetActive(false);
            return go.transform;
        }

        Transform MakePrefab(PerfObject d)
        {
            var prefab = LoadById<GameObject>(d.Prefab);
            if (prefab == null) { Warnings.Add($"The prefab of \"{d.Path}\" was not found; it is left out of the replay."); return null; }
            var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            if (go == null) go = Object.Instantiate(prefab);
            go.name = d.Path;
            go.SetActive(false);
            return go.transform;
        }

        static T LoadById<T>(string id) where T : Object
        {
            if (string.IsNullOrEmpty(id)) return null;
            var colon = id.LastIndexOf(':');
            if (colon < 0 || !long.TryParse(id.Substring(colon + 1), out var local)) return null;
            var path = AssetDatabase.GUIDToAssetPath(id.Substring(0, colon));
            if (string.IsNullOrEmpty(path)) return null;
            foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
                if (o is T typed && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out _, out long l) && l == local) return typed;
            return null;
        }

        // ---- freezing the game ---------------------------------------------------------------------------------------

        static bool KeepScript(MonoBehaviour m)
        {
            var ns = m.GetType().Namespace ?? "";
            return ns.StartsWith("UnityEngine") || ns.StartsWith("Unity.") || ns.StartsWith("Cinemachine") || ns.StartsWith("TMPro") || ns.StartsWith("TrailerForge");
        }

        void Freeze()
        {
            foreach (var rb in Object.FindObjectsByType<Rigidbody>(FindObjectsInactive.Include, FindObjectsSortMode.None)) rb.isKinematic = true;
            foreach (var a in Object.FindObjectsByType<Animator>(FindObjectsInactive.Include, FindObjectsSortMode.None)) a.enabled = false;
            foreach (var n in Object.FindObjectsByType<NavMeshAgent>(FindObjectsInactive.Include, FindObjectsSortMode.None)) n.enabled = false;
            foreach (var c in Object.FindObjectsByType<CharacterController>(FindObjectsInactive.Include, FindObjectsSortMode.None)) c.enabled = false;
            foreach (var p in Object.FindObjectsByType<ParticleSystem>(FindObjectsInactive.Include, FindObjectsSortMode.None)) p.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            foreach (var s in Object.FindObjectsByType<AudioSource>(FindObjectsInactive.Include, FindObjectsSortMode.None)) s.Stop();
            if (!Pass.FreezeScripts) return;
            foreach (var m in Object.FindObjectsByType<MonoBehaviour>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                if (m.enabled && !KeepScript(m)) m.enabled = false;
        }

        // ---- applying a frame ----------------------------------------------------------------------------------------

        void OnLate()
        {
            if (!running) return;
            try
            {
                Apply(next);
                Applied?.Invoke(next, TimeOf(next));
                next++;
                if (next % PerformanceCapture.ScanEvery == 0) HideStrangers();
            }
            catch (Exception e)
            {
                Fail("The replay stopped: " + e.Message);
            }
        }

        double TimeOf(int replayFrame) => replayFrame * (double)Pass.Speed / Pass.Fps;

        /// <summary>Puts every object where the performance has it at a replay frame.</summary>
        public void Apply(int replayFrame)
        {
            var t = TimeOf(replayFrame);
            var frames = Performance.Frames;
            // last recorded frame at or before t (a hair of tolerance: recorded times are single precision)
            int lo = 0, hi = frames.Count - 1;
            while (lo < hi)
            {
                var mid = (lo + hi + 1) / 2;
                if (frames[mid].Time <= t + 1e-6) lo = mid; else hi = mid - 1;
            }
            var i = lo;
            double alpha = 0;
            if (i + 1 < frames.Count)
            {
                var span = frames[i + 1].Time - frames[i].Time;
                if (span > 1e-9) alpha = Math.Max(0, Math.Min(1, (t - frames[i].Time) / span));
                if (alpha < 1e-5) alpha = 0;
            }

            ApplyEvents(i);
            foreach (var kv in bound)
            {
                if (released.Contains(kv.Key) || kv.Value == null) continue;
                var d = defs[kv.Key];
                var a = Performance.SampleAt(kv.Key, i);
                if (a == null) continue;
                var s = a.Value;
                if (alpha > 0)
                {
                    var b = Performance.SampleAt(kv.Key, i + 1);
                    if (b != null)
                    {
                        s.Position = Vector3.LerpUnclamped(s.Position, b.Value.Position, (float)alpha);
                        s.Rotation = Quaternion.SlerpUnclamped(s.Rotation, b.Value.Rotation, (float)alpha);
                        s.Scale = Vector3.LerpUnclamped(s.Scale, b.Value.Scale, (float)alpha);
                    }
                }
                var tr = kv.Value;
                if (d.World)
                {
                    tr.SetPositionAndRotation(s.Position, s.Rotation);
                    tr.localScale = s.Scale;
                }
                else
                {
                    tr.localPosition = s.Position;
                    tr.localRotation = s.Rotation;
                    tr.localScale = s.Scale;
                }
            }
        }

        void ApplyEvents(int frame)
        {
            // objects that come into being on this frame
            foreach (var kv in bound)
            {
                var d = defs[kv.Key];
                if ((d.Kind == PerfObjectKind.StandIn || d.Kind == PerfObjectKind.Prefab) && kv.Value != null && !kv.Value.gameObject.activeSelf &&
                    frame >= d.FirstFrame && !despawned.Contains(d.Id))
                {
                    kv.Value.gameObject.SetActive(true);
                    if (d.Kind == PerfObjectKind.Prefab) FreezeInstance(kv.Value.gameObject);
                }
            }
            var events = Performance.Events;
            while (eventIndex < events.Count && events[eventIndex].Frame <= frame)
            {
                var e = events[eventIndex++];
                if (!bound.TryGetValue(e.Object, out var tr) || tr == null) continue;
                switch (e.Kind)
                {
                    case PerfEventKind.Shown:
                    case PerfEventKind.Hidden:
                        var show = e.Kind == PerfEventKind.Shown;
                        var r = tr.GetComponent<Renderer>();
                        if (r != null) r.enabled = show;
                        var l = tr.GetComponent<Light>();
                        if (l != null) l.enabled = show;
                        break;
                    case PerfEventKind.FieldOfView:
                        var cam = tr.GetComponent<Camera>();
                        if (cam != null && !released.Contains(e.Object)) cam.fieldOfView = e.A;
                        break;
                    case PerfEventKind.ParticlePlay:
                        var ps = tr.GetComponent<ParticleSystem>();
                        if (ps == null) break;
                        ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
                        ps.useAutoRandomSeed = false;
                        ps.randomSeed = e.Seed != 0 ? e.Seed : (uint)(e.Object * 7919 + 1);
                        ps.Play(true);
                        break;
                    case PerfEventKind.ParticleStop:
                        var stop = tr.GetComponent<ParticleSystem>();
                        if (stop != null) stop.Stop(true, ParticleSystemStopBehavior.StopEmitting);
                        break;
                    case PerfEventKind.AudioPlay:
                        var src = tr.GetComponent<AudioSource>();
                        var clip = LoadById<AudioClip>(e.Clip);
                        if (src == null || clip == null || !Request.Audio) break;
                        src.clip = clip;
                        src.time = Mathf.Clamp(e.A, 0, clip.length);
                        src.volume = e.B;
                        src.pitch = e.C;
                        src.Play();
                        break;
                    case PerfEventKind.Despawn:
                        despawned.Add(e.Object);
                        if (defs[e.Object].Kind == PerfObjectKind.StandIn || defs[e.Object].Kind == PerfObjectKind.Prefab) tr.gameObject.SetActive(false);
                        else foreach (var rr in tr.GetComponentsInChildren<Renderer>()) rr.enabled = false;
                        break;
                }
            }
        }

        readonly HashSet<int> despawned = new HashSet<int>();

        void FreezeInstance(GameObject go)
        {
            foreach (var rb in go.GetComponentsInChildren<Rigidbody>(true)) rb.isKinematic = true;
            foreach (var a in go.GetComponentsInChildren<Animator>(true)) a.enabled = false;
            foreach (var p in go.GetComponentsInChildren<ParticleSystem>(true)) p.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            foreach (var m in go.GetComponentsInChildren<MonoBehaviour>(true)) if (!KeepScript(m)) m.enabled = false;
        }

        // Anything the game made during the replay is not part of the performance.
        void HideStrangers()
        {
            foreach (var r in Object.FindObjectsByType<Renderer>(FindObjectsInactive.Exclude, FindObjectsSortMode.None))
            {
                if (known.Contains(r) || r.transform is RectTransform) continue;
                var mine = false;
                for (var x = r.transform; x != null && !mine; x = x.parent)
                    foreach (var kv in bound) if (kv.Value == x && defs[kv.Key].Kind != PerfObjectKind.Scene) { mine = true; break; }
                if (mine) { known.Add(r); continue; }
                r.enabled = false;
            }
        }

        // ---- ending --------------------------------------------------------------------------------------------------

        void Tick()
        {
            if (State != TakeState.Recording) return;
            try
            {
                if (routine.Step()) return;
            }
            catch (Exception e)
            {
                Fail(e.Message);
                return;
            }
            Finish(Recorder?.State ?? TakeState.Failed, Recorder?.Error);
        }

        void OnPlayMode(PlayModeStateChange change)
        {
            // Leaving Play Mode keeps what was filmed (the recorder publishes it); before filming nothing is kept.
            if (change != PlayModeStateChange.ExitingPlayMode || State != TakeState.Recording) return;
            if (Recorder != null && Recorder.State == TakeState.Recording) Recorder.Stop();
            Finish(Recorder?.State == TakeState.Finished ? TakeState.Finished : TakeState.Cancelled, Recorder?.Error);
        }

        /// <summary>Ends now and keeps the take.</summary>
        public void Stop()
        {
            if (State != TakeState.Recording) return;
            if (Recorder == null) { Cancel(); return; }
            Recorder.Stop();
            Finish(Recorder.State, Recorder.Error);
        }

        /// <summary>Ends now and leaves nothing behind.</summary>
        public void Cancel()
        {
            if (State != TakeState.Recording) return;
            Finish(TakeState.Cancelled, null);
        }

        void Fail(string message) => Finish(TakeState.Failed, message);

        void Finish(TakeState state, string error)
        {
            if (State != TakeState.Recording) return;
            EditorApplication.update -= Tick;
            EditorApplication.playModeStateChanged -= OnPlayMode;
            running = false;
            LateHook.Remove(OnLate);
            if (Recorder != null && Recorder.State == TakeState.Recording) Recorder.Cancel();
            Time.captureFramerate = savedCaptureRate;
            Time.timeScale = savedTimeScale;
            cameras.Restore();
            State = state;
            Error = error;
            Done?.Invoke(this);
        }
    }

    /// <summary>Several passes of performances, one after another (each pass reloads the scene).</summary>
    public class ReplayQueue
    {
        public class Entry
        {
            public Performance Performance;
            public ReplayPass Pass;
            public TakeRequest Request;
            public ReplayRun Run;
            public string StartError;
        }

        public List<Entry> Entries { get; } = new List<Entry>();
        public int Index { get; private set; } = -1;
        public bool Running { get; private set; }
        public bool Cancelled { get; private set; }
        public bool ReloadScenes = true;
        public event Action<ReplayQueue> Changed;

        public void Add(Performance performance, ReplayPass pass, TakeRequest request) =>
            Entries.Add(new Entry { Performance = performance, Pass = pass, Request = request });

        public void Start()
        {
            if (Running) return;
            Running = true;
            Cancelled = false;
            Next();
        }

        public void Cancel()
        {
            Cancelled = true;
            var current = Entries.ElementAtOrDefault(Index)?.Run;
            if (current != null && current.State == TakeState.Recording) current.Cancel();
            else if (Running) { Running = false; Changed?.Invoke(this); }
        }

        /// <summary>Runs again what did not finish (failed, cancelled or never started); finished passes are kept.</summary>
        public void Resume()
        {
            if (Running) return;
            var first = Entries.FindIndex(e => e.Run == null || e.Run.State != TakeState.Finished);
            if (first < 0) return;
            foreach (var e in Entries) if (e.Run?.State != TakeState.Finished) { e.Run = null; e.StartError = null; }
            Index = first - 1;
            Running = true;
            Cancelled = false;
            Next();
        }

        public int FinishedCount => Entries.Count(e => e.Run?.State == TakeState.Finished);
        public bool CanResume => !Running && Entries.Any(e => e.Run?.State != TakeState.Finished);

        void Next()
        {
            Index++;
            while (Index < Entries.Count && Entries[Index].Run?.State == TakeState.Finished) Index++;
            if (Cancelled || Index >= Entries.Count) { Running = false; Changed?.Invoke(this); return; }
            var e = Entries[Index];
            try
            {
                e.Run = ReplayRun.Start(e.Performance, e.Pass, e.Request, ReloadScenes);
            }
            catch (Exception ex)
            {
                // a pass that cannot start is skipped; the rest still run
                e.StartError = ex.Message;
                Changed?.Invoke(this);
                EditorApplication.delayCall += Next;
                return;
            }
            e.Run.Done += _ => { Changed?.Invoke(this); EditorApplication.delayCall += Next; };
            Changed?.Invoke(this);
        }
    }
}
