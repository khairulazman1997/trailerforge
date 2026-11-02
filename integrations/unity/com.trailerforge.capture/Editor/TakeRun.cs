using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Playables;

namespace TrailerForge.Capture.Editor
{
    /// <summary>
    /// One take from start to finish: the shot's set-up (if any), then for a camera-only shot its Timeline played at a
    /// locked frame rate, then the recording. Drives itself from the editor loop; <see cref="Cancel"/> leaves nothing behind.
    /// </summary>
    public class TakeRun
    {
        public static TakeRun Current { get; private set; }

        public TakeRequest Request { get; }
        public ShotSetup Setup { get; }
        public TrailerForgeShot CameraShot { get; }
        public TakeState State { get; private set; } = TakeState.Recording;
        /// <summary>True while the set-up steps run, before the recording starts.</summary>
        public bool SettingUp { get; private set; }
        public string Error { get; private set; }
        public ShotRecorder Recorder { get; private set; }
        public event Action<TakeRun> Done;

        Routine routine;
        bool cancelled;
        int savedCaptureRate;
        readonly List<(Camera cam, string tag)> retagged = new List<(Camera, string)>();
        bool recorderDone;

        /// <summary>Starts a take. A camera shot takes its length and camera from the component.</summary>
        public static TakeRun Start(TakeRequest request, ShotSetup setup = null, TrailerForgeShot cameraShot = null)
        {
            if (!Application.isPlaying) throw new InvalidOperationException("Enter Play Mode first: takes are recorded while the game runs.");
            if (Current != null && Current.State == TakeState.Recording) throw new InvalidOperationException("A take is already recording.");
            var run = new TakeRun(request, setup, cameraShot);
            Current = run;
            run.Begin();
            return run;
        }

        TakeRun(TakeRequest request, ShotSetup setup, TrailerForgeShot cameraShot)
        {
            Request = request;
            Setup = setup;
            CameraShot = cameraShot;
        }

        void Begin()
        {
            routine = new Routine(Steps());
            EditorApplication.update += Tick;
            EditorApplication.playModeStateChanged += OnPlayMode;
            Tick();
        }

        IEnumerator Steps()
        {
            if (Setup != null)
            {
                SettingUp = true;
                yield return SetupRunner.Run(Setup);
                SettingUp = false;
            }
            if (CameraShot != null) PrepareCameraShot();
            Recorder = ShotRecorder.Start(Request);
            recorderDone = Recorder.State != TakeState.Recording;
            Recorder.Done += _ => recorderDone = true;
            if (CameraShot != null) CameraShot.Director.Play();
            while (!recorderDone) yield return null;
        }

        void PrepareCameraShot()
        {
            var shot = CameraShot;
            var director = shot.Director;
            if (director == null) throw new InvalidOperationException($"{shot.name} has no PlayableDirector.");
            var seconds = shot.Seconds;
            if (seconds <= 0) throw new InvalidOperationException($"{shot.name} has no length: its Timeline is empty.");
            Request.Seconds = seconds;
            Request.Level = "camera";
            // A locked frame rate: every frame advances the game by exactly 1/fps, whatever the machine can do.
            savedCaptureRate = Time.captureFramerate;
            Time.captureFramerate = Request.Fps;
            director.timeUpdateMode = DirectorUpdateMode.GameTime;
            director.extrapolationMode = DirectorWrapMode.Hold;
            director.time = 0;
            director.Stop();
            if (shot.cameraToRecord != null) IsolateCamera(shot.cameraToRecord);
        }

        // Recorder films "the main camera"; make the shot's camera the only one with that tag.
        void IsolateCamera(Camera cam)
        {
            foreach (var other in UnityEngine.Object.FindObjectsOfType<Camera>(true))
                if (other != cam && other.CompareTag("MainCamera")) { retagged.Add((other, other.tag)); other.tag = "Untagged"; }
            retagged.Add((cam, cam.tag));
            cam.tag = "MainCamera";
        }

        void Restore()
        {
            if (CameraShot != null)
            {
                Time.captureFramerate = savedCaptureRate;
                var d = CameraShot.Director;
                if (d != null) d.Stop();
            }
            foreach (var (cam, tag) in retagged) if (cam != null) cam.tag = tag;
            retagged.Clear();
        }

        void Tick()
        {
            if (State != TakeState.Recording || routine == null) return;
            try
            {
                if (routine.Step()) return;
            }
            catch (Exception e)
            {
                Finish(TakeState.Failed, e.Message);
                return;
            }
            // The recorder finished by itself (or by Stop): its result is ours.
            Finish(Recorder?.State ?? TakeState.Failed, Recorder?.Error);
        }

        void OnPlayMode(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.ExitingPlayMode && State == TakeState.Recording && Recorder == null)
                Finish(TakeState.Cancelled, null);
        }

        /// <summary>Ends the recording now and keeps the take (set-up still running: cancels it).</summary>
        public void Stop()
        {
            if (State != TakeState.Recording) return;
            if (Recorder != null) Recorder.Stop(); else Cancel();
        }

        /// <summary>Ends the take and leaves nothing behind.</summary>
        public void Cancel()
        {
            if (State != TakeState.Recording) return;
            cancelled = true;
            if (Recorder != null && Recorder.State == TakeState.Recording) Recorder.Cancel();
            else if (Recorder == null) Finish(TakeState.Cancelled, null);
        }

        void Finish(TakeState state, string error)
        {
            if (State != TakeState.Recording) return;
            if (cancelled && state == TakeState.Finished) state = Recorder?.State ?? TakeState.Cancelled;
            EditorApplication.update -= Tick;
            EditorApplication.playModeStateChanged -= OnPlayMode;
            if (Recorder != null && Recorder.State == TakeState.Recording) Recorder.Cancel();
            Restore();
            State = state;
            Error = error;
            Done?.Invoke(this);
        }

        public int FramesRecorded => Recorder?.FramesRecorded ?? 0;
        public string FilePath => Recorder?.FilePath;
        public TakeSidecar Sidecar => Recorder?.Sidecar;
        public string Warning => Recorder?.Warning;
    }

    /// <summary>Records the camera-only shots one after another (overnight-friendly: each is its own take).</summary>
    public class ShotQueue
    {
        public class Entry
        {
            public TakeRequest Request;
            public ShotSetup Setup;
            public TrailerForgeShot Shot;
            public TakeRun Run;
        }

        public List<Entry> Entries { get; } = new List<Entry>();
        public int Index { get; private set; } = -1;
        public bool Running { get; private set; }
        public bool Cancelled { get; private set; }
        public event Action<ShotQueue> Changed;

        public void Add(TakeRequest request, TrailerForgeShot shot, ShotSetup setup = null) =>
            Entries.Add(new Entry { Request = request, Shot = shot, Setup = setup });

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
            Entries.ElementAtOrDefault(Index)?.Run?.Cancel();
            if (Running && Entries.ElementAtOrDefault(Index)?.Run == null) { Running = false; Changed?.Invoke(this); }
        }

        void Next()
        {
            Index++;
            if (Cancelled || Index >= Entries.Count) { Running = false; Changed?.Invoke(this); return; }
            var e = Entries[Index];
            try
            {
                e.Run = TakeRun.Start(e.Request, e.Setup, e.Shot);
            }
            catch (Exception ex)
            {
                Running = false;
                Entries[Index].Run = null;
                LastError = ex.Message;
                Changed?.Invoke(this);
                return;
            }
            e.Run.Done += _ => { Changed?.Invoke(this); EditorApplication.delayCall += Next; };
            Changed?.Invoke(this);
        }

        public string LastError { get; private set; }
    }
}
