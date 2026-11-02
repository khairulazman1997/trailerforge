using System;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;

namespace TrailerForge.Capture.Tests
{
    public class CapturePackReaderTests
    {
        // The pack TrailerForge's own tests pin; found by walking up from the Unity project.
        static string Golden()
        {
            var dir = new DirectoryInfo(Application.dataPath);
            while (dir != null)
            {
                var p = Path.Combine(dir.FullName, "packages", "pack-game-trailer", "src", "__golden__", "capture-pack.json");
                if (File.Exists(p)) return p;
                dir = dir.Parent;
            }
            throw new FileNotFoundException("capture-pack.json golden file not found above " + Application.dataPath);
        }

        [Test]
        public void ReadsTheGoldenPack()
        {
            var pack = CapturePackReader.ReadFile(Golden());
            Assert.AreEqual("Ember Knight — Release Trailer", pack.project.name);
            Assert.AreEqual(3840, pack.recording.settings.resolution.width);
            Assert.AreEqual(60, pack.recording.settings.fps);
            Assert.AreEqual("off", pack.recording.settings.hud);
            Assert.AreEqual("spawn_boss", pack.setup.debugCommands[0].name);
            Assert.AreEqual(2, pack.groups.Count);
            var items = pack.Items.ToList();
            Assert.AreEqual(2, items.Count);
            Assert.AreEqual("TF-ZXV5G", items[0].code);
            Assert.IsTrue(items[0].done);
            Assert.AreEqual("TF-PX9B8", items[1].code);
            Assert.AreEqual("Hook", items[1].section);
            Assert.AreEqual("fresh", pack.groups[1].tips.status);
            Assert.IsNull(pack.groups[0].tips);
        }

        [Test]
        public void IgnoresUnknownFieldsAndKeepsDefaultsForMissingOnes()
        {
            var pack = CapturePackReader.Parse("{\"format\":\"trailerforge.capture-pack\",\"version\":1,\"future\":{\"a\":1}}");
            Assert.AreEqual(0, pack.groups.Count);
            Assert.AreEqual(1920, pack.recording.settings.resolution.width);
        }

        [Test]
        public void RefusesAnotherFormat()
        {
            var e = Assert.Throws<CapturePackException>(() => CapturePackReader.Parse("{\"format\":\"other\",\"version\":1}"));
            StringAssert.Contains("not a TrailerForge capture pack", e.Message);
        }

        [Test]
        public void RefusesAnotherVersion()
        {
            var e = Assert.Throws<CapturePackException>(() =>
                CapturePackReader.Parse("{\"format\":\"trailerforge.capture-pack\",\"version\":2}"));
            StringAssert.Contains("version 2", e.Message);
        }

        [Test]
        public void RefusesBrokenJsonAndMissingFiles()
        {
            Assert.Throws<CapturePackException>(() => CapturePackReader.Parse("{ nope"));
            Assert.Throws<CapturePackException>(() => CapturePackReader.ReadFile(Path.Combine(Path.GetTempPath(), "tf-missing.json")));
        }
    }

    public class TakeCounterTests
    {
        string dir;

        [SetUp]
        public void Make()
        {
            dir = Path.Combine(Path.GetTempPath(), "tf-takes-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
        }

        [TearDown]
        public void Clean() => Directory.Delete(dir, true);

        [Test]
        public void CountsFinishedTakesByCodeAndSkipsTemporaryOnes()
        {
            foreach (var n in new[]
            {
                "TF-ZXV5G_take1.mov", "TF-zxv5g_take2.mp4", "TF-PX9B8.mov",
                "TF-PX9B8_take2.mov.tmp", ".TF-PX9B8_take3.mov", "TF-PX9B8_take1.tfshot.json", "notes.mov",
            })
                File.WriteAllText(Path.Combine(dir, n), "x");
            var counts = TakeCounter.Count(dir);
            Assert.AreEqual(2, counts["TF-ZXV5G"]);
            Assert.AreEqual(1, counts["TF-PX9B8"]);
            Assert.AreEqual(2, counts.Count);
        }

        [Test]
        public void AMissingFolderHasNoTakes() =>
            Assert.AreEqual(0, TakeCounter.Count(Path.Combine(dir, "nope")).Count);
    }
}
