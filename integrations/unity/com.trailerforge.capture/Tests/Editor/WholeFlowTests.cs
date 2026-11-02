using System;
using System.Collections;
using System.IO;
using System.Linq;
using NUnit.Framework;
using TrailerForge.Capture.Editor;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.TestTools;
using UnityEngine.Timeline;

namespace TrailerForge.Capture.Tests
{
    /// <summary>
    /// The Unity half of the whole flow (task 9.9): reads a capture pack TrailerForge exported and records three of its
    /// takes into the folder TrailerForge watches: shot 1 live (level 1), shot 2 as a camera-only Timeline shot
    /// (level 3), then shot 1 again, captured once and filmed again at half speed (level 4, its second take). Driven by the engine test
    /// `unity-flow.test.ts`, which passes TFORGE_FLOW_PACK and TFORGE_FLOW_OUT; ignored without them.
    /// </summary>
    public class WholeFlowTests
    {
        string packPath;
        string outDir;
        string perfDir;

        [SetUp]
        public void Make()
        {
            packPath = Environment.GetEnvironmentVariable("TFORGE_FLOW_PACK");
            outDir = Environment.GetEnvironmentVariable("TFORGE_FLOW_OUT");
            if (string.IsNullOrEmpty(packPath) || string.IsNullOrEmpty(outDir))
                Assert.Ignore("Run through the engine's unity-flow test (pnpm test:unity).");
            perfDir = Path.Combine(Path.GetTempPath(), "tf-flow-perf-" + Guid.NewGuid().ToString("N"));
            EditorSettings.enterPlayModeOptionsEnabled = true;
            EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload | EnterPlayModeOptions.DisableSceneReload;
            EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
        }

        [UnityTearDown]
        public IEnumerator Clean()
        {
            if (Application.isPlaying) yield return new ExitPlayMode();
            Time.captureFramerate = 0;
            if (perfDir != null && Directory.Exists(perfDir)) Directory.Delete(perfDir, true);
        }

        // Small and short, so the flow stays quick; everything else comes from the pack.
        static TakeRequest Small(TakeRequest r)
        {
            r.Width = 320;
            r.Height = 180;
            r.Fps = 30;
            r.Seconds = 2;
            r.Format = TakeFormat.H264;
            return r;
        }

        static IEnumerator Until(Func<bool> done, int maxFrames = 3000)
        {
            for (var i = 0; i < maxFrames && !done(); i++) yield return null;
            Assert.IsTrue(done(), "timed out");
        }

        [UnityTest]
        public IEnumerator RecordsLevelsOneThreeAndFourFromAnExportedPack()
        {
            var pack = CapturePackReader.ReadFile(packPath);
            var items = pack.Items.Where(i => !string.IsNullOrEmpty(i.code)).Take(2).ToList();
            Assert.AreEqual(2, items.Count, "the pack has two shots to record");

            // something that moves, for every level
            var mover = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            mover.name = "Hero";
            var cam = Camera.main;
            cam.transform.position = new Vector3(0, 1, -6);

            // level 3: a Timeline plays the shot hands-free
            var shotGo = new GameObject("Shot " + items[1].code);
            var director = shotGo.AddComponent<PlayableDirector>();
            director.playOnAwake = false;
            var timeline = ScriptableObject.CreateInstance<TimelineAsset>();
            var clip = timeline.CreateTrack<ActivationTrack>(null, "Hero").CreateDefaultClip();
            clip.start = 0;
            clip.duration = 2;
            director.playableAsset = timeline;
            director.SetGenericBinding(timeline.GetOutputTracks().First(), mover);
            var cameraShot = shotGo.AddComponent<TrailerForgeShot>();
            cameraShot.code = items[1].code;
            cameraShot.director = director;

            yield return new EnterPlayMode();

            // level 1: one click, played live
            var live = TakeRun.Start(Small(TakeRequest.FromPack(pack, items[0], outDir)));
            for (var i = 0; live.State == TakeState.Recording && i < 3000; i++)
            {
                mover.transform.position = new Vector3(Mathf.Sin(i * 0.1f) * 2, 1, 0);
                yield return null;
            }
            Assert.AreEqual(TakeState.Finished, live.State, live.Error);

            // level 3
            var camera = TakeRun.Start(Small(TakeRequest.FromPack(pack, items[1], outDir)), null, cameraShot);
            yield return Until(() => camera.State != TakeState.Recording);
            Assert.AreEqual(TakeState.Finished, camera.State, camera.Error);

            // level 4: play once (captured), then film it again at half speed
            Time.captureFramerate = 30;
            var cap = PerformanceCapture.Start(items[0].code, 1, perfDir);
            for (var i = 0; cap.State == CaptureState.Capturing && i < 3000; i++)
            {
                mover.transform.position = new Vector3(i * 0.05f, 1, 0);
                yield return null;
            }
            Time.captureFramerate = 0;
            Assert.AreEqual(CaptureState.Finished, cap.State, cap.Error);
            var perf = PerformanceReader.ReadFile(cap.FilePath);
            var pass = new ReplayPass { Speed = 0.5f, Width = 320, Height = 180, Fps = 30, Format = TakeFormat.H264 };
            var replay = ReplayRun.Start(perf, pass, TakeRequest.FromPack(pack, items[0], outDir), reloadScenes: false);
            yield return Until(() => replay.State != TakeState.Recording);
            yield return new ExitPlayMode();
            Assert.AreEqual(TakeState.Finished, replay.State, replay.Error ?? replay.Recorder?.Error);

            var sidecars = Directory.GetFiles(outDir, "*.tfshot.json").Select(TakeFiles.ReadSidecar).OrderBy(s => s.level).ToList();
            CollectionAssert.AreEqual(new[] { "camera", "live", "replay" }, sidecars.Select(s => s.level).ToArray());
            Assert.AreEqual(items[0].code, sidecars[2].code);
            Assert.AreEqual(2, sidecars[2].take, "the replay is the second take of shot 1");
            Assert.AreEqual(2.0, sidecars[2].seconds, 0.05, "1 s played, filmed at half speed");
            Assert.AreEqual(perf.Meta.id, sidecars[2].performanceId);
            Assert.AreEqual(pack.project.id, sidecars[0].projectId);
            Assert.AreEqual(0, Directory.Exists(TakeFiles.PartialDir(outDir)) ? Directory.GetFiles(TakeFiles.PartialDir(outDir)).Length : 0);
        }
    }
}
