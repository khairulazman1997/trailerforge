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
using UnityEngine.SceneManagement;
using UnityEngine.Timeline;
using UnityEngine.TestTools;

namespace TrailerForge.Capture.Tests
{
    /// <summary>Steps a game would mark for TrailerForge Capture.</summary>
    public static class TestSteps
    {
        public static string Flag = "";
        public static int Count;
        public static bool Waited;

        [TrailerForgeSetup]
        public static void SetFlag(string value, int times = 1)
        {
            Flag = value;
            Count += times;
        }

        [TrailerForgeSetup("Wait a bit")]
        public static IEnumerator WaitSeconds(float seconds)
        {
            yield return new WaitForSecondsRealtime(seconds);
            Waited = true;
        }

        [TrailerForgeSetup]
        public static void Boom() => throw new InvalidOperationException("no boss here");
    }

    /// <summary>Set-up steps and camera-only shots, in Play Mode with real recordings (needs graphics and ffprobe).</summary>
    public class TakeRunTests
    {
        const string SceneDir = "Assets/TfTests";
        const string ScenePath = SceneDir + "/SetupScene.unity";
        string dir;

        [SetUp]
        public void Make()
        {
            dir = Path.Combine(Path.GetTempPath(), "tf-run-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            EditorSettings.enterPlayModeOptionsEnabled = true;
            EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload | EnterPlayModeOptions.DisableSceneReload;
            TestSteps.Flag = "";
            TestSteps.Count = 0;
            TestSteps.Waited = false;

            // A scene with a camera and a player, saved so a set-up can load it by asset.
            Directory.CreateDirectory(SceneDir);
            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            var player = GameObject.CreatePrimitive(PrimitiveType.Cube);
            player.name = "Hero";
            player.tag = "Player";
            player.transform.position = new Vector3(0, 1, -3);
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.Refresh();
            EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
        }

        [TearDown]
        public void Clean()
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            AssetDatabase.DeleteAsset(SceneDir);
        }

        TakeRequest Request(string code, double seconds, int fps) => new TakeRequest
        {
            Code = code,
            SlotId = "shot_x",
            ProjectId = "proj_sample",
            OutputFolder = dir,
            Width = 640,
            Height = 360,
            Fps = fps,
            Seconds = seconds,
            Format = TakeFormat.H264,
            Audio = false,
        };

        static IEnumerator Until(Func<bool> done, int maxFrames = 3000)
        {
            for (var i = 0; i < maxFrames && !done(); i++) yield return null;
        }

        static TrailerForgeShot CameraShot(string code, double seconds)
        {
            var go = new GameObject("Shot " + code);
            var director = go.AddComponent<PlayableDirector>();
            director.playOnAwake = false;
            var timeline = ScriptableObject.CreateInstance<TimelineAsset>();
            var track = timeline.CreateTrack<ActivationTrack>(null, "Act");
            var clip = track.CreateDefaultClip();
            clip.start = 0;
            clip.duration = seconds;
            director.playableAsset = timeline;
            var shot = go.AddComponent<TrailerForgeShot>();
            shot.code = code;
            shot.director = director;
            return shot;
        }

        [UnityTest]
        public IEnumerator SetUpLoadsTheSceneMovesThePlayerRunsStepsThenRecords()
        {
            var setup = ScriptableObject.CreateInstance<ShotSetup>();
            setup.code = "TF-PX9B8";
            setup.scene = AssetDatabase.LoadAssetAtPath<SceneAsset>(ScenePath);
            setup.moveTarget = true;
            setup.startPosition = new Vector3(4, 1, -3);
            setup.steps.Add(new SetupStep { method = "SetFlag", args = new[] { "armed", "2" } });
            setup.steps.Add(new SetupStep { method = "Wait a bit", args = new[] { "0.2" } });

            yield return new EnterPlayMode();
            var run = TakeRun.Start(Request("TF-PX9B8", 1, 30), setup);
            Assert.IsTrue(run.SettingUp || run.State != TakeState.Recording || run.Recorder != null);
            yield return Until(() => run.State != TakeState.Recording);
            var heroPosition = GameObject.FindWithTag("Player").transform.position;
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Finished, run.State, run.Error);
            Assert.AreEqual("armed", TestSteps.Flag);
            Assert.AreEqual(2, TestSteps.Count);
            Assert.IsTrue(TestSteps.Waited);
            Assert.AreEqual(4f, heroPosition.x, 0.001f);
            Assert.AreEqual("640,360,30", ShotRecorderTests.Probe(run.FilePath));
        }

        [UnityTest]
        public IEnumerator AFailingStepStopsTheTakeWithItsMessageAndLeavesNoFile()
        {
            var setup = ScriptableObject.CreateInstance<ShotSetup>();
            setup.steps.Add(new SetupStep { method = "SetFlag", args = new[] { "before" } });
            setup.steps.Add(new SetupStep { method = "Boom" });
            setup.steps.Add(new SetupStep { method = "SetFlag", args = new[] { "after" } });

            yield return new EnterPlayMode();
            var run = TakeRun.Start(Request("TF-PX9B8", 1, 30), setup);
            yield return Until(() => run.State != TakeState.Recording);
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Failed, run.State);
            StringAssert.Contains("Set-up step 2 (Boom)", run.Error);
            StringAssert.Contains("no boss here", run.Error);
            Assert.AreEqual("before", TestSteps.Flag);
            Assert.AreEqual(0, Directory.GetFileSystemEntries(dir).Length);
        }

        [UnityTest]
        public IEnumerator UnknownStepsAndBadArgumentsAreExplained()
        {
            var unknown = ScriptableObject.CreateInstance<ShotSetup>();
            unknown.steps.Add(new SetupStep { method = "NoSuchStep" });
            var badArg = ScriptableObject.CreateInstance<ShotSetup>();
            badArg.steps.Add(new SetupStep { method = "SetFlag", args = new[] { "x", "many" } });

            yield return new EnterPlayMode();
            var a = TakeRun.Start(Request("TF-PX9B8", 1, 30), unknown);
            yield return Until(() => a.State != TakeState.Recording);
            var b = TakeRun.Start(Request("TF-PX9B8", 1, 30), badArg);
            yield return Until(() => b.State != TakeState.Recording);
            yield return new ExitPlayMode();

            StringAssert.Contains("No set-up step named \"NoSuchStep\"", a.Error);
            StringAssert.Contains("\"many\" is not a valid Int32", b.Error);
            Assert.AreEqual(0, Directory.GetFileSystemEntries(dir).Length);
        }

        [UnityTest]
        public IEnumerator ACancelDuringSetUpLeavesNothing()
        {
            var setup = ScriptableObject.CreateInstance<ShotSetup>();
            setup.steps.Add(new SetupStep { method = "Wait a bit", args = new[] { "30" } });

            yield return new EnterPlayMode();
            var run = TakeRun.Start(Request("TF-PX9B8", 1, 30), setup);
            for (var i = 0; i < 5; i++) yield return null;
            Assert.IsTrue(run.SettingUp);
            run.Cancel();
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Cancelled, run.State);
            Assert.AreEqual(0, Directory.GetFileSystemEntries(dir).Length);
        }

        [UnityTest]
        public IEnumerator ACameraShotRecordsItsTimelineAtALockedFrameRate()
        {
            yield return new EnterPlayMode();
            var shot = CameraShot("TF-PX9B8", 3);
            var run = TakeRun.Start(Request("TF-PX9B8", 0, 60), null, shot);
            yield return Until(() => run.State != TakeState.Recording);
            var rateAfter = Time.captureFramerate;
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Finished, run.State, run.Error);
            Assert.AreEqual("640,360,180", ShotRecorderTests.Probe(run.FilePath));
            Assert.AreEqual(180, run.Sidecar.frames);
            Assert.AreEqual(60, run.Sidecar.pass.fps);
            Assert.AreEqual(0, rateAfter, "the locked frame rate is released after the take");
        }

        [UnityTest]
        public IEnumerator TheQueueRecordsCameraShotsInOrderAndCanBeCancelled()
        {
            yield return new EnterPlayMode();
            var first = CameraShot("TF-PX9B8", 1);
            var second = CameraShot("TF-ZXV5G", 2);
            var queue = new ShotQueue();
            queue.Add(Request("TF-PX9B8", 0, 30), first);
            queue.Add(Request("TF-ZXV5G", 0, 30), second);
            queue.Start();
            yield return Until(() => !queue.Running, 6000);
            yield return new ExitPlayMode();

            var runs = queue.Entries.Select(e => e.Run).ToList();
            Assert.IsTrue(runs.All(r => r != null && r.State == TakeState.Finished), string.Join(";", runs.Select(r => r?.Error)));
            Assert.AreEqual(30, runs[0].Sidecar.frames);
            Assert.AreEqual(60, runs[1].Sidecar.frames);
            Assert.Less(File.GetCreationTimeUtc(runs[0].FilePath), File.GetCreationTimeUtc(runs[1].FilePath));
        }

        [UnityTest]
        public IEnumerator CancellingTheQueueStopsTheRest()
        {
            yield return new EnterPlayMode();
            var queue = new ShotQueue();
            queue.Add(Request("TF-PX9B8", 0, 30), CameraShot("TF-PX9B8", 4));
            queue.Add(Request("TF-ZXV5G", 0, 30), CameraShot("TF-ZXV5G", 1));
            queue.Start();
            for (var i = 0; i < 10; i++) yield return null;
            queue.Cancel();
            yield return Until(() => !queue.Running);
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Cancelled, queue.Entries[0].Run.State);
            Assert.IsNull(queue.Entries[1].Run, "the second shot never started");
            Assert.AreEqual(0, Directory.GetFileSystemEntries(dir).Length);
        }
    }
}
