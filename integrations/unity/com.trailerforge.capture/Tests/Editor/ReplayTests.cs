using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using TrailerForge.Capture.Editor;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.TestTools;

namespace TrailerForge.Capture.Tests
{
    /// <summary>Capture a wandering object, then film it again (needs graphics).</summary>
    public class ReplayTests
    {
        const string SceneDir = "Assets/TfReplayTests";
        const string ScenePath = SceneDir + "/Replay.unity";
        string dir;
        string perfDir;

        // a game script in the fixture project's own assembly (scripts of editor assemblies get no Update in Play Mode)
        static readonly Type Wanderer = Type.GetType("ReplayFixtureWanderer, Assembly-CSharp", true);
        static int WandererUpdates => (int)Wanderer.GetField("Updates").GetValue(null);

        [SetUp]
        public void Make()
        {
            dir = Path.Combine(Path.GetTempPath(), "tf-replay-" + Guid.NewGuid().ToString("N"));
            perfDir = Path.Combine(dir, "perf");
            EditorSettings.enterPlayModeOptionsEnabled = true;
            EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload | EnterPlayModeOptions.DisableSceneReload;
            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            var mover = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            mover.name = "Mover";
            mover.AddComponent(Wanderer);
            for (var i = 0; i < 5; i++) GameObject.CreatePrimitive(PrimitiveType.Cube).transform.position = new Vector3(i * 2, 0, 4);
            Directory.CreateDirectory(SceneDir);
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.Refresh();
        }

        [UnityTearDown]
        public IEnumerator Clean()
        {
            if (Application.isPlaying) yield return new ExitPlayMode();
            Time.captureFramerate = 0;
            Time.timeScale = 1;
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            if (AssetDatabase.IsValidFolder(SceneDir)) AssetDatabase.DeleteAsset(SceneDir);
        }

        static IEnumerator Capture(string folder, List<Performance> result)
        {
            Time.captureFramerate = 30;
            var cap = PerformanceCapture.Start("TF-PX9B8", 3, folder);
            for (var i = 0; cap.State == CaptureState.Capturing && i < 1000; i++) yield return null;
            Time.captureFramerate = 0;
            Assert.AreEqual(CaptureState.Finished, cap.State, cap.Error);
            result.Add(PerformanceReader.ReadFile(cap.FilePath));
        }

        static ReplayPass Pass(float speed, bool freeze = true) =>
            new ReplayPass { Speed = speed, Width = 320, Height = 180, Fps = 30, Format = TakeFormat.H264, FreezeScripts = freeze };

        TakeRequest Request() => new TakeRequest { Code = "TF-PX9B8", SlotId = "shot_a", ProjectId = "prj_1", OutputFolder = dir };

        static int MoverId(Performance p) =>
            p.Objects.Single(o => o.Kind == PerfObjectKind.Scene && o.Path.Contains("|Mover[")).Id;

        /// <summary>What the performance says at a (possibly fractional) recorded frame.</summary>
        static PerfSample Expected(Performance p, int id, double frame)
        {
            var i = (int)Math.Floor(frame + 1e-9);
            var a = p.SampleAt(id, i).Value;
            var f = frame - i;
            if (f < 1e-9 || i + 1 >= p.Frames.Count) return a;
            var b = p.SampleAt(id, i + 1).Value;
            a.Position = Vector3.Lerp(a.Position, b.Position, (float)f);
            a.Rotation = Quaternion.Slerp(a.Rotation, b.Rotation, (float)f);
            a.Scale = Vector3.Lerp(a.Scale, b.Scale, (float)f);
            return a;
        }

        static void AssertPose(PerfSample want, Transform t, string what)
        {
            Assert.Less((t.localPosition - want.Position).magnitude, 1e-4f, what + " position");
            Assert.Less(Quaternion.Angle(t.localRotation, want.Rotation), 0.01f, what + " rotation");
            Assert.Less((t.localScale - want.Scale).magnitude, 1e-4f, what + " scale");
        }

        /// <summary>Checks every applied frame, and that the pose is still there when the frame is over.</summary>
        class Watcher
        {
            public int Applied;
            public int Exact;
            public int Between;
            public int LastFrame = -1;
            public string Failure;
            readonly Performance perf;
            readonly int id;
            ReplayRun run;

            public Watcher(Performance perf, int id) { this.perf = perf; this.id = id; }

            public void Attach(ReplayRun r)
            {
                run = r;
                r.Applied += OnApplied;
            }

            void OnApplied(int frame, double time)
            {
                Applied++;
                LastFrame = frame;
                var recorded = time * 30;
                if (recorded > perf.Frames.Count - 1) recorded = perf.Frames.Count - 1;
                if (Math.Abs(recorded - Math.Round(recorded)) < 1e-6) Exact++; else Between++;
                try { AssertPose(Expected(perf, id, recorded), run.Bound(id), $"frame {frame}"); }
                catch (AssertionException e) { Failure ??= e.Message; }
            }

            /// <summary>Called between frames: the game had its turn since the last apply, and must not have moved it.</summary>
            public void CheckStill()
            {
                if (LastFrame < 0 || run.State != TakeState.Recording || Failure != null) return;
                var recorded = Math.Min(LastFrame * run.Pass.Speed, perf.Frames.Count - 1);
                try { AssertPose(Expected(perf, id, recorded), run.Bound(id), $"after frame {LastFrame}"); }
                catch (AssertionException e) { Failure = e.Message; }
            }
        }

        [UnityTest]
        public IEnumerator FilmsAPerformanceAgainAtFullAndHalfSpeed()
        {
            yield return new EnterPlayMode();
            var perfs = new List<Performance>();
            yield return Capture(perfDir, perfs);
            var perf = perfs[0];
            var id = MoverId(perf);
            Assert.Greater(perf.Samples[id].Count, 80, "the wanderer moved on every frame");
            Assert.AreEqual(91, perf.Frames.Count);

            var queue = new ReplayQueue();
            queue.Add(perf, Pass(1), Request());
            queue.Add(perf, Pass(0.5f), Request());
            var watchers = new[] { new Watcher(perf, id), new Watcher(perf, id) };
            var frozen = new List<bool>();
            var attached = new HashSet<int>();
            queue.Changed += q =>
            {
                var e = q.Entries.ElementAtOrDefault(q.Index);
                if (e?.Run == null || !attached.Add(q.Index)) return;
                watchers[q.Index].Attach(e.Run);
            };
            queue.Start();
            for (var i = 0; (queue.Running) && i < 3000; i++)
            {
                foreach (var w in watchers) w.CheckStill();
                var run = ReplayRun.Current;
                if (run != null && run.State == TakeState.Recording && run.Bound(id) != null && frozen.Count < queue.Index + 1)
                    frozen.Add(!((Behaviour)run.Bound(id).GetComponent(Wanderer)).enabled);
                yield return null;
            }
            var runs = queue.Entries.Select(e => e.Run).ToList();
            yield return new ExitPlayMode();

            Assert.IsFalse(queue.Running, "the queue finished");
            foreach (var e in queue.Entries) Assert.IsNull(e.StartError);
            Assert.AreEqual(TakeState.Finished, runs[0].State, runs[0].Error);
            Assert.AreEqual(TakeState.Finished, runs[1].State, runs[1].Error);
            CollectionAssert.AreEqual(new[] { true, true }, frozen, "game scripts are turned off");
            foreach (var w in watchers) Assert.IsNull(w.Failure, w.Failure);

            // 1×: every replay frame is a recorded frame
            Assert.GreaterOrEqual(watchers[0].Applied, 90);
            Assert.AreEqual(0, watchers[0].Between);
            // 0.5×: even frames hit a recorded frame, odd ones fall half way
            Assert.GreaterOrEqual(watchers[1].Applied, 180);
            Assert.Greater(watchers[1].Between, 80);
            Assert.Greater(watchers[1].Exact, 80);

            // two takes of the same shot
            var a = runs[0].Recorder;
            var b = runs[1].Recorder;
            StringAssert.EndsWith("TF-PX9B8_take01.mp4", a.FilePath);
            StringAssert.EndsWith("TF-PX9B8_take02.mp4", b.FilePath);
            Assert.AreEqual("320,180,90", ShotRecorderTests.Probe(a.FilePath));
            Assert.AreEqual("320,180,180", ShotRecorderTests.Probe(b.FilePath));
            var sa = TakeFiles.ReadSidecar(Path.Combine(dir, "TF-PX9B8_take01.tfshot.json"));
            var sb = TakeFiles.ReadSidecar(Path.Combine(dir, "TF-PX9B8_take02.tfshot.json"));
            Assert.AreEqual("replay", sa.level);
            Assert.AreEqual(perf.Meta.id, sa.performanceId);
            Assert.AreEqual(1.0, sa.pass.speed);
            Assert.AreEqual(0.5, sb.pass.speed);
            Assert.AreEqual("recorded", sb.pass.camera);
            Assert.AreEqual(6.0, sb.seconds);
            Assert.AreEqual(1f, Time.timeScale, "time scale restored");
        }

        [UnityTest]
        public IEnumerator ReplayWinsOverGameScriptsLeftRunning()
        {
            yield return new EnterPlayMode();
            var perfs = new List<Performance>();
            yield return Capture(perfDir, perfs);
            var perf = perfs[0];
            var id = MoverId(perf);
            var watcher = new Watcher(perf, id);
            var run = ReplayRun.Start(perf, Pass(1, freeze: false), Request());
            watcher.Attach(run);
            var updatesAtStart = -1;
            for (var i = 0; run.State == TakeState.Recording && i < 2000; i++)
            {
                watcher.CheckStill();
                if (updatesAtStart < 0 && run.Bound(id) != null) updatesAtStart = WandererUpdates;
                yield return null;
            }
            var wandererRan = WandererUpdates - updatesAtStart;
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Finished, run.State, run.Error);
            Assert.Greater(wandererRan, 50, "the game script kept running");
            Assert.IsNull(watcher.Failure, watcher.Failure);
            Assert.GreaterOrEqual(watcher.Applied, 90);
        }

        [UnityTest]
        public IEnumerator ACancelledReplayLeavesNothingAndRestoresTime()
        {
            yield return new EnterPlayMode();
            var perfs = new List<Performance>();
            yield return Capture(perfDir, perfs);
            var run = ReplayRun.Start(perfs[0], Pass(0.5f), Request());
            for (var i = 0; i < 30; i++) yield return null;
            Assert.AreEqual(0.5f, Time.timeScale);
            run.Cancel();
            Assert.AreEqual(1f, Time.timeScale);
            Assert.AreEqual(0, Time.captureFramerate);
            yield return new ExitPlayMode();
            Assert.AreEqual(TakeState.Cancelled, run.State);
            Assert.IsFalse(Directory.GetFiles(dir).Any(f => f.Contains("_take")));
        }

        static IEnumerator Drain(ReplayQueue queue)
        {
            for (var i = 0; queue.Running && i < 4000; i++) yield return null;
            // the queue starts the next pass one editor tick after the last one ends
            yield return null;
        }

        [UnityTest]
        public IEnumerator AFailedPassDoesNotStopTheQueueAndResumeRunsOnlyWhatDidNotFinish()
        {
            yield return new EnterPlayMode();
            var perfs = new List<Performance>();
            yield return Capture(perfDir, perfs);
            var perf = perfs[0];

            var bad = Pass(1);
            bad.Camera = ReplayCamera.Tagged;
            bad.CameraTag = "NoSuchCamera";
            var queue = new ReplayQueue();
            queue.Add(perf, Pass(1), Request());
            queue.Add(perf, bad, Request());
            queue.Add(perf, Pass(1), Request());
            queue.Start();
            yield return Drain(queue);

            CollectionAssert.AreEqual(new[] { TakeState.Finished, TakeState.Failed, TakeState.Finished }, queue.Entries.Select(e => e.Run.State).ToArray());
            Assert.AreEqual(2, queue.FinishedCount);
            Assert.IsTrue(queue.CanResume);
            var kept = queue.Entries[0].Run;

            // fix the pass, then run only the one that failed
            bad.Camera = ReplayCamera.Recorded;
            queue.Resume();
            yield return Drain(queue);
            yield return new ExitPlayMode();

            Assert.AreSame(kept, queue.Entries[0].Run, "a finished pass is not run again");
            Assert.AreEqual(3, queue.FinishedCount);
            Assert.IsFalse(queue.CanResume);
            // take numbers: pass 1 = take01, pass 3 = take02, the repaired pass 2 = take03
            Assert.AreEqual(1, queue.Entries[0].Run.Recorder.Take);
            Assert.AreEqual(2, queue.Entries[2].Run.Recorder.Take);
            Assert.AreEqual(3, queue.Entries[1].Run.Recorder.Take);
            Assert.AreEqual(3, Directory.GetFiles(dir, "*.mp4").Length);
        }

        [UnityTest]
        public IEnumerator CancellingTheQueueStopsTheRestAndResumeFinishesThem()
        {
            yield return new EnterPlayMode();
            var perfs = new List<Performance>();
            yield return Capture(perfDir, perfs);
            var queue = new ReplayQueue();
            for (var i = 0; i < 3; i++) queue.Add(perfs[0], Pass(1), Request());
            queue.Start();
            for (var i = 0; i < 20; i++) yield return null;
            queue.Cancel();
            yield return Drain(queue);

            Assert.IsFalse(queue.Running);
            Assert.AreEqual(TakeState.Cancelled, queue.Entries[0].Run.State);
            Assert.IsNull(queue.Entries[1].Run, "the rest never started");
            Assert.AreEqual(0, Directory.GetFiles(dir, "*.mp4").Length);

            queue.Resume();
            yield return Drain(queue);
            yield return new ExitPlayMode();
            Assert.AreEqual(3, queue.FinishedCount);
            Assert.AreEqual(3, Directory.GetFiles(dir, "*.mp4").Length);
        }
    }
}
