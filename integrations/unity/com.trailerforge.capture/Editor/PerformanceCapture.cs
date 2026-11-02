using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace TrailerForge.Capture.Editor
{
    public enum CaptureState { Capturing, Finished, Cancelled, Failed }

    /// <summary>
    /// Records a performance while the user plays (level 4a): every frame, after all game scripts and animation
    /// and before rendering, the transforms of everything visible that changed, plus show/hide, camera field of view,
    /// particle and audio starts, spawns and despawns. Written to a temporary file and renamed when finished.
    /// </summary>
    public class PerformanceCapture
    {
        public static PerformanceCapture Current { get; private set; }

        /// <summary>Where performances go: outside Assets, so Unity does not import them.</summary>
        public static string DefaultFolder => Path.Combine(Path.GetDirectoryName(Application.dataPath) ?? ".", "TrailerForge", "Performances");

        /// <summary>How often (in frames) objects that appeared without the Spawned hook are looked for.</summary>
        public const int ScanEvery = 5;

        const float PosEps = 1e-5f, RotEps = 1e-6f, ScaleEps = 1e-6f;

        public CaptureState State { get; private set; } = CaptureState.Capturing;
        public string Error { get; private set; }
        public string FilePath { get; private set; }
        public string Id { get; }
        public string Code { get; }
        /// <summary>Stops by itself after this much game time; 0 = until stopped.</summary>
        public double Seconds { get; }
        public int Frames => writer?.FrameCount ?? frames;
        public long Bytes { get; private set; }
        public List<string> Warnings { get; } = new List<string>();
        public event Action<PerformanceCapture> Done;

        class Tracked
        {
            public PerfObject Def;
            public Transform T;
            public Renderer Renderer;
            public Camera Camera;
            public ParticleSystem Particles;
            public AudioSource Audio;
            public Vector3 Pos, Scale;
            public Quaternion Rot;
            public bool Shown;
            public float Fov;
            public bool ParticlesPlaying;
            public bool AudioPlaying;
            public float AudioTime;
        }

        readonly string folder;
        readonly string tempPath;
        PerformanceWriter writer;
        readonly List<Tracked> tracked = new List<Tracked>();
        readonly Dictionary<Transform, Tracked> byTransform = new Dictionary<Transform, Tracked>();
        readonly HashSet<string> warned = new HashSet<string>();
        float startTime;
        int frames;
        int nextId;

        public static PerformanceCapture Start(string code, double seconds = 0, string outputFolder = null)
        {
            if (!Application.isPlaying) throw new InvalidOperationException("Enter Play Mode first: a performance is captured while you play.");
            if (Current != null && Current.State == CaptureState.Capturing) throw new InvalidOperationException("A performance is already being captured.");
            Current = new PerformanceCapture(code ?? "", seconds, outputFolder ?? DefaultFolder);
            return Current;
        }

        PerformanceCapture(string code, double seconds, string folder)
        {
            Code = code.Trim().ToUpperInvariant();
            Seconds = seconds;
            this.folder = folder;
            Directory.CreateDirectory(folder);
            Id = "perf_" + Guid.NewGuid().ToString("N").Substring(0, 12);
            var n = NextNumber(folder, Code);
            FilePath = Path.Combine(folder, $"{(Code.Length > 0 ? Code : "perf")}_perf{n:00}{PerformanceFormat.Extension}");
            tempPath = FilePath + ".tmp";
            var meta = new PerformanceMeta
            {
                id = Id,
                code = Code,
                scenes = Enumerable.Range(0, SceneManager.sceneCount).Select(i => SceneManager.GetSceneAt(i).path).ToList(),
                unityVersion = Application.unityVersion,
                package = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(PerformanceCapture).Assembly)?.version ?? "",
            };
            writer = new PerformanceWriter(tempPath, meta);
            startTime = Time.time;
            TrackScene();
            TrailerForgeCapture.OnSpawned += OnSpawned;
            LateHook.Add(Sample);
            EditorApplication.playModeStateChanged += OnPlayMode;
            Sample(); // the state at the start, before the next rendered frame
        }

        static int NextNumber(string folder, string code)
        {
            var max = 0;
            var prefix = (code.Length > 0 ? code : "perf") + "_perf";
            foreach (var f in Directory.GetFiles(folder, "*" + PerformanceFormat.Extension))
            {
                var name = Path.GetFileNameWithoutExtension(f);
                if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && int.TryParse(name.Substring(prefix.Length), out var k))
                    max = Math.Max(max, k);
            }
            return max + 1;
        }

        // ---- what is tracked ------------------------------------------------------------------------------

        static bool Wanted(Component c) =>
            c != null && c.hideFlags == HideFlags.None && !(c.transform is RectTransform) &&
            (c is Renderer || c is Camera || c is Light || c is AudioSource || c is ParticleSystem);

        void TrackScene()
        {
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects())
                foreach (var c in root.GetComponentsInChildren<Component>(true))
                {
                    if (!Wanted(c)) continue;
                    TrackWithAncestors(c.transform, null);
                    if (c is SkinnedMeshRenderer smr)
                        foreach (var bone in smr.bones)
                            if (bone != null) TrackWithAncestors(bone, null);
                }
            }
        }

        // Ancestors are tracked too, so replaying local transforms rebuilds the whole hierarchy.
        Tracked TrackWithAncestors(Transform t, Tracked prefabRoot)
        {
            if (byTransform.TryGetValue(t, out var have)) return have;
            if (prefabRoot != null && t == prefabRoot.T) return prefabRoot;
            if (t.parent != null && (prefabRoot == null || t.IsChildOf(prefabRoot.T)))
                TrackWithAncestors(t.parent, prefabRoot);
            var def = new PerfObject
            {
                Id = nextId++,
                Kind = prefabRoot != null ? PerfObjectKind.PrefabPart : PerfObjectKind.Scene,
                Path = prefabRoot != null ? RelativePath(prefabRoot.T, t) : ScenePath(t),
                Parent = prefabRoot?.Def.Id ?? -1,
                FirstFrame = Math.Max(frames - 1, 0),
            };
            return Add(def, t);
        }

        Tracked Add(PerfObject def, Transform t)
        {
            var tr = new Tracked
            {
                Def = def,
                T = t,
                Renderer = t.GetComponent<Renderer>(),
                Camera = t.GetComponent<Camera>(),
                Particles = t.GetComponent<ParticleSystem>(),
                Audio = t.GetComponent<AudioSource>(),
                Pos = new Vector3(float.NaN, 0, 0),
            };
            def.IsCamera = tr.Camera != null;
            def.HasRenderer = tr.Renderer != null;
            writer.Object(def);
            tracked.Add(tr);
            byTransform[t] = tr;
            tr.Shown = !IsShown(tr); // forces the first Shown/Hidden event
            tr.Fov = float.NaN;
            return tr;
        }

        /// <summary>"Scenes/Level.unity|Root[0]/Child[2]": names with sibling index, so duplicates stay apart.</summary>
        public static string ScenePath(Transform t) => t.gameObject.scene.path + "|" + Chain(t, null);

        public static string RelativePath(Transform root, Transform t) => Chain(t, root);

        static string Chain(Transform t, Transform stopAt)
        {
            var parts = new List<string>();
            for (var x = t; x != null && x != stopAt; x = x.parent) parts.Add(x.name + "[" + x.GetSiblingIndex() + "]");
            parts.Reverse();
            return string.Join("/", parts);
        }

        void OnSpawned(GameObject prefab, GameObject instance)
        {
            if (State != CaptureState.Capturing || byTransform.ContainsKey(instance.transform)) return;
            var guid = AssetId(prefab);
            if (guid.Length == 0) { Warn($"\"{prefab.name}\" passed to Spawned is not a prefab asset; it replays as a stand-in."); return; }
            var root = Add(new PerfObject
            {
                Id = nextId++,
                Kind = PerfObjectKind.Prefab,
                Path = instance.name,
                World = true,
                Prefab = guid,
                FirstFrame = Math.Max(frames - 1, 0),
            }, instance.transform);
            foreach (var c in instance.GetComponentsInChildren<Component>(true))
                if (Wanted(c) && c.transform != instance.transform) TrackWithAncestors(c.transform, root);
        }

        void ScanForNewObjects()
        {
            foreach (var r in UnityEngine.Object.FindObjectsByType<Renderer>(FindObjectsInactive.Exclude, FindObjectsSortMode.None))
            {
                if (!Wanted(r) || byTransform.ContainsKey(r.transform) || UnderPrefab(r.transform)) continue;
                if (r is ParticleSystemRenderer)
                {
                    Warn($"Spawned particle effect \"{r.name}\" is not replayed; call TrailerForgeCapture.Spawned(prefab, instance) where it is created.");
                    continue;
                }
                Mesh mesh = null;
                if (r is SkinnedMeshRenderer smr)
                {
                    mesh = smr.sharedMesh;
                    Warn($"Spawned animated object \"{r.name}\" replays in its rest pose; call TrailerForgeCapture.Spawned for an exact replay.");
                }
                else if (r.TryGetComponent<MeshFilter>(out var mf)) mesh = mf.sharedMesh;
                if (mesh == null) { Warn($"Spawned object \"{r.name}\" has no mesh to stand in for it and is not replayed."); continue; }
                var def = new PerfObject
                {
                    Id = nextId++,
                    Kind = PerfObjectKind.StandIn,
                    Path = r.name,
                    World = true,
                    Mesh = AssetId(mesh),
                    Materials = r.sharedMaterials.Select(m => m != null ? AssetId(m) : "").ToList(),
                    FirstFrame = Math.Max(frames - 1, 0),
                };
                Add(def, r.transform);
            }
        }

        bool UnderPrefab(Transform t)
        {
            for (var x = t.parent; x != null; x = x.parent)
                if (byTransform.TryGetValue(x, out var tr) && tr.Def.Kind == PerfObjectKind.Prefab) return true;
            return false;
        }

        static string AssetId(UnityEngine.Object o) =>
            o != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out var guid, out long local) ? guid + ":" + local : "";

        void Warn(string message)
        {
            if (!warned.Add(message)) return;
            Warnings.Add(message);
            writer.Warning(message);
        }

        // ---- sampling -------------------------------------------------------------------------------------

        static bool IsShown(Tracked t) =>
            t.T.gameObject.activeInHierarchy && (t.Renderer == null || t.Renderer.enabled);

        void Sample()
        {
            if (State != CaptureState.Capturing) return;
            try
            {
                var now = Time.time - startTime;
                writer.Frame(now, Time.deltaTime);
                frames++;
                if (frames > 1 && frames % ScanEvery == 0) ScanForNewObjects();
                for (var i = tracked.Count - 1; i >= 0; i--)
                {
                    var t = tracked[i];
                    if (t.T == null) // destroyed
                    {
                        writer.Event(new PerfEvent { Object = t.Def.Id, Kind = PerfEventKind.Despawn });
                        tracked.RemoveAt(i);
                        continue;
                    }
                    SampleOne(t);
                }
                if (Seconds > 0 && now >= Seconds - 1e-6) Finish(true);
            }
            catch (Exception e)
            {
                Fail("The capture stopped: " + e.Message);
            }
        }

        void SampleOne(Tracked t)
        {
            Vector3 p, s;
            Quaternion r;
            if (t.Def.World) { p = t.T.position; r = t.T.rotation; s = t.T.lossyScale; }
            else { p = t.T.localPosition; r = t.T.localRotation; s = t.T.localScale; }
            var first = float.IsNaN(t.Pos.x);
            var dp = first || (p - t.Pos).sqrMagnitude > PosEps * PosEps;
            var dr = first || Mathf.Abs(r.x - t.Rot.x) > RotEps || Mathf.Abs(r.y - t.Rot.y) > RotEps || Mathf.Abs(r.z - t.Rot.z) > RotEps || Mathf.Abs(r.w - t.Rot.w) > RotEps;
            var ds = first || (s - t.Scale).sqrMagnitude > ScaleEps * ScaleEps;
            if (dp || dr || ds)
            {
                writer.Transform(t.Def.Id, dp ? p : (Vector3?)null, dr ? r : (Quaternion?)null, ds ? s : (Vector3?)null);
                if (dp) t.Pos = p;
                if (dr) t.Rot = r;
                if (ds) t.Scale = s;
            }

            var shown = IsShown(t);
            if (shown != t.Shown)
            {
                writer.Event(new PerfEvent { Object = t.Def.Id, Kind = shown ? PerfEventKind.Shown : PerfEventKind.Hidden });
                t.Shown = shown;
            }
            if (t.Camera != null && !Mathf.Approximately(t.Camera.fieldOfView, t.Fov))
            {
                t.Fov = t.Camera.fieldOfView;
                writer.Event(new PerfEvent { Object = t.Def.Id, Kind = PerfEventKind.FieldOfView, A = t.Fov });
            }
            if (t.Particles != null && t.Particles.isPlaying != t.ParticlesPlaying)
            {
                t.ParticlesPlaying = t.Particles.isPlaying;
                writer.Event(new PerfEvent
                {
                    Object = t.Def.Id,
                    Kind = t.ParticlesPlaying ? PerfEventKind.ParticlePlay : PerfEventKind.ParticleStop,
                    Seed = t.Particles.useAutoRandomSeed ? 0u : t.Particles.randomSeed,
                });
            }
            if (t.Audio != null)
            {
                var playing = t.Audio.isPlaying;
                var restarted = playing && t.AudioPlaying && t.Audio.time + 0.05f < t.AudioTime;
                if ((playing && !t.AudioPlaying) || restarted)
                {
                    writer.Event(new PerfEvent
                    {
                        Object = t.Def.Id,
                        Kind = PerfEventKind.AudioPlay,
                        Clip = AssetId(t.Audio.clip),
                        A = t.Audio.time,
                        B = t.Audio.volume,
                        C = t.Audio.pitch,
                    });
                }
                t.AudioPlaying = playing;
                t.AudioTime = t.Audio.time;
            }
        }

        // ---- ending -------------------------------------------------------------------------------------------

        void OnPlayMode(PlayModeStateChange change)
        {
            // Leaving Play Mode keeps what was captured.
            if (change == PlayModeStateChange.ExitingPlayMode && State == CaptureState.Capturing) Finish(true);
        }

        /// <summary>Ends the capture and keeps it.</summary>
        public void Stop()
        {
            if (State == CaptureState.Capturing) Finish(true);
        }

        /// <summary>Ends the capture and leaves nothing behind.</summary>
        public void Cancel()
        {
            if (State == CaptureState.Capturing) Finish(false);
        }

        void Finish(bool keep)
        {
            Detach();
            try
            {
                if (keep) writer.End();
                writer.Dispose();
                writer = null;
                if (!keep)
                {
                    File.Delete(tempPath);
                    State = CaptureState.Cancelled;
                }
                else
                {
                    File.Move(tempPath, FilePath);
                    Bytes = new FileInfo(FilePath).Length;
                    State = CaptureState.Finished;
                }
            }
            catch (Exception e)
            {
                State = CaptureState.Failed;
                Error = "The performance could not be saved: " + e.Message;
            }
            Done?.Invoke(this);
        }

        void Fail(string message)
        {
            Detach();
            try { writer?.Dispose(); } catch (Exception) { /* already failing */ }
            writer = null;
            try { File.Delete(tempPath); } catch (Exception) { /* nothing to clean */ }
            State = CaptureState.Failed;
            Error = message;
            Done?.Invoke(this);
        }

        void Detach()
        {
            LateHook.Remove(Sample);
            TrailerForgeCapture.OnSpawned -= OnSpawned;
            EditorApplication.playModeStateChanged -= OnPlayMode;
        }
    }
}
