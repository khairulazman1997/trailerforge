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
    public class PerformanceFormatTests
    {
        string dir;

        [SetUp]
        public void Make()
        {
            dir = Path.Combine(Path.GetTempPath(), "tf-perf-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
        }

        [TearDown]
        public void Clean() => Directory.Delete(dir, true);

        string WriteSample(bool end = true)
        {
            var path = Path.Combine(dir, "a.tfperf");
            using (var w = new PerformanceWriter(path, new PerformanceMeta { id = "perf_1", code = "TF-PX9B8", scenes = new List<string> { "Assets/A.unity" } }))
            {
                w.Frame(0, 0);
                w.Object(new PerfObject { Id = 0, Kind = PerfObjectKind.Scene, Path = "Assets/A.unity|Hero[0]", HasRenderer = true });
                w.Object(new PerfObject { Id = 1, Kind = PerfObjectKind.Scene, Path = "Assets/A.unity|Cam[1]", IsCamera = true });
                w.Object(new PerfObject { Id = 2, Kind = PerfObjectKind.StandIn, Path = "Bullet", World = true, Mesh = "g1:10", Materials = new List<string> { "g2:20", "" } });
                w.Object(new PerfObject { Id = 3, Kind = PerfObjectKind.Prefab, Path = "Boss(Clone)", World = true, Prefab = "g3:30" });
                w.Object(new PerfObject { Id = 4, Kind = PerfObjectKind.PrefabPart, Path = "Body[0]", Parent = 3 });
                w.Transform(0, new Vector3(1, 2, 3), new Quaternion(0, 0.6f, 0, 0.8f), Vector3.one * 2);
                w.Event(new PerfEvent { Object = 0, Kind = PerfEventKind.Shown });
                w.Event(new PerfEvent { Object = 1, Kind = PerfEventKind.FieldOfView, A = 55 });
                w.Frame(1.0 / 30, 1f / 30);
                w.Transform(0, new Vector3(4, 5, 6), null, null);
                w.Event(new PerfEvent { Object = 3, Kind = PerfEventKind.ParticlePlay, Seed = 1234 });
                w.Event(new PerfEvent { Object = 3, Kind = PerfEventKind.AudioPlay, Clip = "g4:40", A = 0.5f, B = 0.8f, C = 1.1f });
                w.Event(new PerfEvent { Object = 2, Kind = PerfEventKind.Despawn });
                w.Warning("a warning");
                w.Frame(2.0 / 30, 1f / 30);
                w.Event(new PerfEvent { Object = 0, Kind = PerfEventKind.Hidden });
                w.Event(new PerfEvent { Object = 3, Kind = PerfEventKind.ParticleStop });
                if (end) w.End();
            }
            return path;
        }

        [Test]
        public void EveryRecordTypeSurvivesARoundTrip()
        {
            var p = PerformanceReader.ReadFile(WriteSample());
            Assert.AreEqual("perf_1", p.Meta.id);
            Assert.AreEqual("TF-PX9B8", p.Meta.code);
            Assert.AreEqual(3, p.Frames.Count);
            Assert.AreEqual(2.0 / 30, p.Seconds, 1e-12);
            Assert.AreEqual(5, p.Objects.Count);
            var standIn = p.Objects[2];
            Assert.AreEqual(PerfObjectKind.StandIn, standIn.Kind);
            Assert.IsTrue(standIn.World);
            Assert.AreEqual("g1:10", standIn.Mesh);
            CollectionAssert.AreEqual(new[] { "g2:20", "" }, standIn.Materials);
            Assert.AreEqual("g3:30", p.Objects[3].Prefab);
            Assert.AreEqual(3, p.Objects[4].Parent);
            Assert.IsTrue(p.Objects[1].IsCamera);
            Assert.IsTrue(p.Objects[0].HasRenderer);

            var hero = p.Samples[0];
            Assert.AreEqual(2, hero.Count);
            Assert.AreEqual(new Vector3(4, 5, 6), hero[1].Position);
            // what did not change carries forward
            Assert.AreEqual(new Quaternion(0, 0.6f, 0, 0.8f), hero[1].Rotation);
            Assert.AreEqual(Vector3.one * 2, hero[1].Scale);
            Assert.AreEqual(1, hero[1].Frame);
            Assert.AreEqual(new Vector3(4, 5, 6), p.SampleAt(0, 2).Value.Position);
            Assert.AreEqual(new Vector3(1, 2, 3), p.SampleAt(0, 0).Value.Position);
            Assert.IsNull(p.SampleAt(2, 0));

            var kinds = p.Events.Select(e => (e.Frame, e.Object, e.Kind)).ToList();
            CollectionAssert.AreEqual(new[]
            {
                (0, 0, PerfEventKind.Shown), (0, 1, PerfEventKind.FieldOfView), (1, 3, PerfEventKind.ParticlePlay),
                (1, 3, PerfEventKind.AudioPlay), (1, 2, PerfEventKind.Despawn), (2, 0, PerfEventKind.Hidden), (2, 3, PerfEventKind.ParticleStop),
            }, kinds);
            Assert.AreEqual(55, p.Events[1].A);
            Assert.AreEqual(1234u, p.Events[2].Seed);
            var audio = p.Events[3];
            Assert.AreEqual("g4:40", audio.Clip);
            Assert.AreEqual(0.5f, audio.A);
            Assert.AreEqual(0.8f, audio.B);
            Assert.AreEqual(1.1f, audio.C);
            CollectionAssert.AreEqual(new[] { "a warning" }, p.Warnings);
        }

        [Test]
        public void ACaptureThatDidNotFinishIsRefused()
        {
            var e = Assert.Throws<PerformanceFormatException>(() => PerformanceReader.ReadFile(WriteSample(end: false)));
            StringAssert.Contains("incomplete", e.Message);
        }

        [Test]
        public void ACutOffFileIsRefused()
        {
            var path = WriteSample();
            var bytes = File.ReadAllBytes(path);
            File.WriteAllBytes(path, bytes.Take(bytes.Length / 2).ToArray());
            Assert.Throws<PerformanceFormatException>(() => PerformanceReader.ReadFile(path));
        }

        [Test]
        public void AnotherVersionOrAnotherFileIsRefused()
        {
            var path = WriteSample();
            var bytes = File.ReadAllBytes(path);
            bytes[6] = 2;
            File.WriteAllBytes(path, bytes);
            StringAssert.Contains("version 2", Assert.Throws<PerformanceFormatException>(() => PerformanceReader.ReadFile(path)).Message);
            File.WriteAllText(path, "not a performance at all");
            StringAssert.Contains("not a TrailerForge performance", Assert.Throws<PerformanceFormatException>(() => PerformanceReader.ReadFile(path)).Message);
        }
    }

    /// <summary>A real capture in Play Mode at a locked 30 fps (needs graphics).</summary>
    public class PerformanceCaptureTests
    {
        const string PrefabDir = "Assets/TfPerfTests";
        const string PrefabPath = PrefabDir + "/Boss.prefab";
        string dir;

        [SetUp]
        public void Make()
        {
            dir = Path.Combine(Path.GetTempPath(), "tf-perfcap-" + Guid.NewGuid().ToString("N"));
            EditorSettings.enterPlayModeOptionsEnabled = true;
            EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload | EnterPlayModeOptions.DisableSceneReload;
            EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            for (var i = 0; i < 50; i++)
            {
                var c = GameObject.CreatePrimitive(PrimitiveType.Cube);
                c.name = "Still";
                c.transform.position = new Vector3(i % 10, 0, i / 10);
            }
        }

        [TearDown]
        public void Clean()
        {
            Time.captureFramerate = 0;
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            if (AssetDatabase.IsValidFolder(PrefabDir)) AssetDatabase.DeleteAsset(PrefabDir);
        }

        static void MakeBossPrefab()
        {
            Directory.CreateDirectory(PrefabDir);
            var boss = new GameObject("Boss");
            var body = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            body.name = "Body";
            body.transform.SetParent(boss.transform, false);
            PrefabUtility.SaveAsPrefabAsset(boss, PrefabPath);
            UnityEngine.Object.DestroyImmediate(boss);
        }

        [UnityTest]
        public IEnumerator CapturesMotionVisibilityCameraParticlesAndSpawns()
        {
            MakeBossPrefab();
            var mover = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            mover.name = "Mover";
            var blinker = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            blinker.name = "Blinker";
            var sparks = new GameObject("Sparks").AddComponent<ParticleSystem>();
            sparks.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            var main = sparks.main;
            main.playOnAwake = false;
            sparks.useAutoRandomSeed = false;
            sparks.randomSeed = 1234;

            yield return new EnterPlayMode();
            Time.captureFramerate = 30;
            var cap = PerformanceCapture.Start("TF-PX9B8", 5, dir);
            var cam = Camera.main;
            GameObject standIn = null;
            var frame = 0;
            while (cap.State == CaptureState.Capturing && frame < 2000)
            {
                frame++;
                mover.transform.position = new Vector3(frame * 0.1f, 1, 0);
                if (frame == 10) blinker.GetComponent<Renderer>().enabled = false;
                if (frame == 20) blinker.GetComponent<Renderer>().enabled = true;
                if (frame == 30) sparks.Play();
                if (frame == 40) cam.fieldOfView = 40;
                if (frame == 50) standIn = GameObject.CreatePrimitive(PrimitiveType.Cube);
                if (frame == 60)
                {
                    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PrefabPath);
                    TrailerForgeCapture.Spawned(prefab, UnityEngine.Object.Instantiate(prefab));
                    new GameObject("Smoke").AddComponent<ParticleSystem>();
                }
                if (frame == 90) UnityEngine.Object.Destroy(standIn);
                yield return null;
            }
            yield return new ExitPlayMode();

            Assert.AreEqual(CaptureState.Finished, cap.State, cap.Error);
            StringAssert.EndsWith("TF-PX9B8_perf01.tfperf", cap.FilePath);
            Assert.IsFalse(File.Exists(cap.FilePath + ".tmp"));
            var p = PerformanceReader.ReadFile(cap.FilePath);
            Debug.Log($"performance: {p.Frames.Count} frames, {p.Objects.Count} objects, {cap.Bytes} bytes");

            Assert.AreEqual(151, p.Frames.Count, "5 s at a locked 30 fps, both ends included");
            Assert.AreEqual(5.0, p.Seconds, 1e-3);
            Assert.AreEqual(cap.Id, p.Meta.id);

            var byName = p.Objects.Where(o => o.Kind == PerfObjectKind.Scene).ToLookup(o => o.Path.Substring(o.Path.LastIndexOf('|') + 1).Split('[')[0]);
            var still = byName["Still"].First();
            Assert.AreEqual(1, p.Samples[still.Id].Count, "a still object costs one sample");
            var moverId = byName["Mover"].Single().Id;
            var xs = p.Samples[moverId].Select(s => s.Position.x).ToList();
            Assert.Greater(xs.Count, 140);
            for (var i = 1; i < xs.Count; i++) Assert.Greater(xs[i], xs[i - 1]);

            var blinkerId = byName["Blinker"].Single().Id;
            var blinks = p.Events.Where(e => e.Object == blinkerId).Select(e => e.Kind).ToList();
            CollectionAssert.AreEqual(new[] { PerfEventKind.Shown, PerfEventKind.Hidden, PerfEventKind.Shown }, blinks);
            var hidden = p.Events.First(e => e.Object == blinkerId && e.Kind == PerfEventKind.Hidden);
            var shownAgain = p.Events.Last(e => e.Object == blinkerId);
            Assert.AreEqual(10, shownAgain.Frame - hidden.Frame);

            var play = p.Events.Single(e => e.Kind == PerfEventKind.ParticlePlay && e.Object == byName["Sparks"].Single().Id);
            Assert.AreEqual(1234u, play.Seed);
            var camId = p.Objects.Single(o => o.IsCamera).Id;
            Assert.AreEqual(40, p.Events.Last(e => e.Object == camId && e.Kind == PerfEventKind.FieldOfView).A);

            var stand = p.Objects.Single(o => o.Kind == PerfObjectKind.StandIn);
            StringAssert.StartsWith("0000000000000000e000000000000000:", stand.Mesh, "the built-in cube mesh");
            Assert.AreEqual(1, stand.Materials.Count);
            Assert.IsTrue(p.Events.Any(e => e.Object == stand.Id && e.Kind == PerfEventKind.Despawn));

            var prefabGuid = AssetDatabase.AssetPathToGUID(PrefabPath);
            var bossRoot = p.Objects.Single(o => o.Kind == PerfObjectKind.Prefab);
            StringAssert.StartsWith(prefabGuid + ":", bossRoot.Prefab);
            var part = p.Objects.Single(o => o.Kind == PerfObjectKind.PrefabPart);
            Assert.AreEqual(bossRoot.Id, part.Parent);
            Assert.AreEqual("Body[0]", part.Path);
            Assert.IsTrue(p.Warnings.Any(w => w.Contains("Spawned particle effect \"Smoke\"")), string.Join(" | ", p.Warnings));

            Assert.Less(cap.Bytes, 100_000, "about 60 objects for 5 s");
        }

        [UnityTest]
        public IEnumerator ACancelledCaptureLeavesNothing()
        {
            yield return new EnterPlayMode();
            var cap = PerformanceCapture.Start("TF-PX9B8", 0, dir);
            for (var i = 0; i < 10; i++) yield return null;
            cap.Cancel();
            yield return new ExitPlayMode();
            Assert.AreEqual(CaptureState.Cancelled, cap.State);
            Assert.AreEqual(0, Directory.GetFileSystemEntries(dir).Length);
        }

        [UnityTest]
        public IEnumerator LeavingPlayModeKeepsTheCapture()
        {
            yield return new EnterPlayMode();
            var cap = PerformanceCapture.Start("", 0, dir);
            for (var i = 0; i < 10; i++) yield return null;
            yield return new ExitPlayMode();
            Assert.AreEqual(CaptureState.Finished, cap.State, cap.Error);
            StringAssert.EndsWith("perf_perf01.tfperf", cap.FilePath);
            Assert.Greater(PerformanceReader.ReadFile(cap.FilePath).Frames.Count, 5);
        }
    }
}
