using System;
using System.IO;
using NUnit.Framework;
using TrailerForge.Capture.Editor;
using UnityEngine;

namespace TrailerForge.Capture.Tests
{
    public class CaptureChecksTests
    {
        string dir;

        [SetUp]
        public void Make() => dir = Path.Combine(Path.GetTempPath(), "tf-checks-" + Guid.NewGuid().ToString("N"));

        [TearDown]
        public void Clean()
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }

        [Test]
        public void AnEmptyOutputFolderAsksForOne()
        {
            var p = CaptureChecks.OutputFolder("");
            StringAssert.Contains("Pick the folder", p.Message);
            Assert.IsNull(p.Fix);
        }

        [Test]
        public void AMissingOutputFolderCanBeCreated()
        {
            var p = CaptureChecks.OutputFolder(dir);
            StringAssert.Contains("does not exist", p.Message);
            p.Fix();
            Assert.IsTrue(Directory.Exists(dir));
            Assert.IsNull(CaptureChecks.OutputFolder(dir));
            Assert.AreEqual(0, Directory.GetFileSystemEntries(dir).Length, "the write test leaves nothing behind");
        }

        [Test]
        public void ACameraCanvasOutsideTheUiLayerIsFoundOnlyWhenTheHudIsOff()
        {
            var ui = LayerMask.NameToLayer("UI");
            Assert.GreaterOrEqual(ui, 0);
            var world = new GameObject("WorldHud", typeof(Canvas)).GetComponent<Canvas>();
            world.renderMode = RenderMode.WorldSpace;
            var overlay = new GameObject("Overlay", typeof(Canvas)).GetComponent<Canvas>();
            overlay.renderMode = RenderMode.ScreenSpaceOverlay;
            var tidy = new GameObject("Tidy", typeof(Canvas)).GetComponent<Canvas>();
            tidy.renderMode = RenderMode.WorldSpace;
            tidy.gameObject.layer = ui;
            try
            {
                var found = CaptureChecks.HudCanvasesOutsideUiLayer();
                CollectionAssert.AreEqual(new[] { world }, found);
                StringAssert.Contains("WorldHud", CaptureChecks.Hud(false).Message);
                Assert.IsNull(CaptureChecks.Hud(true), "with the HUD on there is nothing to hide");
                world.gameObject.layer = ui;
                Assert.IsNull(CaptureChecks.Hud(false));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(world.gameObject);
                UnityEngine.Object.DestroyImmediate(overlay.gameObject);
                UnityEngine.Object.DestroyImmediate(tidy.gameObject);
            }
        }
    }
}
