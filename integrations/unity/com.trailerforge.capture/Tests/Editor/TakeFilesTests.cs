using System;
using System.IO;
using NUnit.Framework;

namespace TrailerForge.Capture.Tests
{
    public class TakeFilesTests
    {
        string dir;

        [SetUp]
        public void Make()
        {
            dir = Path.Combine(Path.GetTempPath(), "tf-files-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
        }

        [TearDown]
        public void Clean() => Directory.Delete(dir, true);

        [Test]
        public void NamesTakesSoTrailerForgeReadsCodeAndTake()
        {
            Assert.AreEqual("TF-PX9B8_take03", TakeFiles.BaseName("TF-PX9B8", 3));
            Assert.AreEqual("TF-PX9B8_take120", TakeFiles.BaseName("TF-PX9B8", 120));
        }

        [Test]
        public void NextTakeFollowsRecordingsAndSidecarsButNotPartialOnes()
        {
            Assert.AreEqual(1, TakeFiles.NextTake(dir, "TF-PX9B8"));
            File.WriteAllText(Path.Combine(dir, "TF-PX9B8_take02.mov"), "x");
            File.WriteAllText(Path.Combine(dir, "TF-PX9B8_take04.tfshot.json"), "{}");
            File.WriteAllText(Path.Combine(dir, "TF-ZXV5G_take09.mov"), "x");
            Directory.CreateDirectory(TakeFiles.PartialDir(dir));
            File.WriteAllText(Path.Combine(TakeFiles.PartialDir(dir), "TF-PX9B8_take07.mov"), "x");
            Assert.AreEqual(5, TakeFiles.NextTake(dir, "TF-PX9B8"));
            Assert.AreEqual(10, TakeFiles.NextTake(dir, "TF-ZXV5G"));
        }

        [Test]
        public void PublishMovesTheSidecarThenTheRecordingAndCleansUp()
        {
            var partial = TakeFiles.PartialDir(dir);
            Directory.CreateDirectory(partial);
            var file = Path.Combine(partial, "TF-PX9B8_take01.mp4");
            File.WriteAllText(file, "video");
            var dest = TakeFiles.Publish(file, dir, new TakeSidecar { code = "TF-PX9B8", take = 1, frames = 60 });
            Assert.AreEqual(Path.Combine(dir, "TF-PX9B8_take01.mp4"), dest);
            Assert.IsTrue(File.Exists(dest));
            Assert.IsFalse(Directory.Exists(partial));
            var sidecar = TakeFiles.ReadSidecar(Path.Combine(dir, "TF-PX9B8_take01.tfshot.json"));
            Assert.AreEqual("trailerforge.unity-take", sidecar.format);
            Assert.AreEqual("TF-PX9B8_take01.mp4", sidecar.file);
            Assert.AreEqual(60, sidecar.frames);
            Assert.AreEqual(1, TakeCounter.Count(dir)["TF-PX9B8"]);
        }

        [Test]
        public void PublishRefusesToOverwriteATake()
        {
            var partial = TakeFiles.PartialDir(dir);
            Directory.CreateDirectory(partial);
            var file = Path.Combine(partial, "TF-PX9B8_take01.mp4");
            File.WriteAllText(file, "new");
            File.WriteAllText(Path.Combine(dir, "TF-PX9B8_take01.mp4"), "old");
            Assert.Throws<IOException>(() => TakeFiles.Publish(file, dir, new TakeSidecar()));
            Assert.AreEqual("old", File.ReadAllText(Path.Combine(dir, "TF-PX9B8_take01.mp4")));
            Assert.IsFalse(File.Exists(Path.Combine(dir, "TF-PX9B8_take01.tfshot.json")));
        }
    }
}
