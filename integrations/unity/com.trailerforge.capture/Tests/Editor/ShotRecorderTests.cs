using System;
using System.Collections;
using System.Diagnostics;
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
    /// <summary>Real recordings in Play Mode (needs graphics: `pnpm test:unity` runs Unity without -nographics).</summary>
    public class ShotRecorderTests
    {
        string dir;

        [SetUp]
        public void Make()
        {
            dir = Path.Combine(Path.GetTempPath(), "tf-rec-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            // Keep the test alive across Play Mode: no domain or scene reload.
            EditorSettings.enterPlayModeOptionsEnabled = true;
            EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload | EnterPlayModeOptions.DisableSceneReload;
            EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cube.transform.position = new Vector3(0, 1, -5);
        }

        [TearDown]
        public void Clean()
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }

        TakeRequest Request(double seconds, TakeFormat format) => new TakeRequest
        {
            Code = "TF-PX9B8",
            SlotId = "shot_parry",
            ProjectId = "proj_sample",
            OutputFolder = dir,
            Width = 1280,
            Height = 720,
            Fps = 30,
            Seconds = seconds,
            Format = format,
            Audio = false,
        };

        static IEnumerator WaitUntilDone(ShotRecorder rec, int maxFrames = 2000)
        {
            for (var i = 0; i < maxFrames && rec.State == TakeState.Recording; i++) yield return null;
        }

        [Test]
        public void RefusesOutsidePlayMode()
        {
            var e = Assert.Throws<InvalidOperationException>(() => ShotRecorder.Start(Request(1, TakeFormat.H264)));
            StringAssert.Contains("Play Mode", e.Message);
        }

        [UnityTest]
        public IEnumerator RecordsATimedTakeWithExactFramesAndASidecar()
        {
            yield return new EnterPlayMode();
            var rec = ShotRecorder.Start(Request(2, TakeFormat.H264));
            yield return null;
            // While recording, nothing TrailerForge could import is in the folder yet.
            Assert.AreEqual(0, TakeFiles.Files(dir).Count());
            yield return WaitUntilDone(rec);
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Finished, rec.State, rec.Error);
            Assert.AreEqual(Path.Combine(dir, "TF-PX9B8_take01.mp4"), rec.FilePath);
            Assert.IsFalse(Directory.Exists(TakeFiles.PartialDir(dir)));
            var probe = Probe(rec.FilePath);
            Assert.AreEqual("1280,720,60", probe);
            var sidecar = TakeFiles.ReadSidecar(Path.Combine(dir, "TF-PX9B8_take01.tfshot.json"));
            Assert.AreEqual("TF-PX9B8", sidecar.code);
            Assert.AreEqual("shot_parry", sidecar.slotId);
            Assert.AreEqual(1, sidecar.take);
            Assert.AreEqual(60, sidecar.frames);
            Assert.AreEqual(2.0, sidecar.seconds);
            Assert.AreEqual("off", sidecar.pass.hud);
            Assert.AreEqual("h264", sidecar.pass.codec);
            Assert.AreEqual(30, sidecar.pass.fps);
        }

        [UnityTest]
        public IEnumerator RecordsProResAndNumbersTheNextTake()
        {
            File.WriteAllText(Path.Combine(dir, "TF-PX9B8_take01.mp4"), "earlier take");
            yield return new EnterPlayMode();
            var rec = ShotRecorder.Start(Request(1, TakeFormat.ProRes422HQ));
            yield return WaitUntilDone(rec);
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Finished, rec.State, rec.Error);
            Assert.AreEqual(2, rec.Take);
            StringAssert.EndsWith("TF-PX9B8_take02.mov", rec.FilePath);
            Assert.AreEqual("1280,720,30", Probe(rec.FilePath));
            Assert.AreEqual("prores-422-hq", rec.Sidecar.pass.codec);
        }

        [UnityTest]
        public IEnumerator ACancelledTakeLeavesNothing()
        {
            yield return new EnterPlayMode();
            var rec = ShotRecorder.Start(Request(0, TakeFormat.H264));
            for (var i = 0; i < 10; i++) yield return null;
            rec.Cancel();
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Cancelled, rec.State);
            Assert.AreEqual(0, Directory.GetFileSystemEntries(dir).Length);
        }

        [UnityTest]
        public IEnumerator AManualTakeStopsByHandAndIsKept()
        {
            yield return new EnterPlayMode();
            var rec = ShotRecorder.Start(Request(0, TakeFormat.H264));
            for (var i = 0; i < 15; i++) yield return null;
            rec.Stop();
            yield return new ExitPlayMode();

            Assert.AreEqual(TakeState.Finished, rec.State, rec.Error);
            Assert.IsTrue(File.Exists(rec.FilePath));
            Assert.Greater(rec.Sidecar.frames, 0);
        }

        /// <summary>"width,height,frames" of the first video stream, counted by decoding.</summary>
        internal static string Probe(string file)
        {
            var dirEnv = Environment.GetEnvironmentVariable("TFORGE_FFMPEG_DIR");
            var exe = string.IsNullOrEmpty(dirEnv) ? "ffprobe" : Path.Combine(dirEnv, "ffprobe");
            var info = new ProcessStartInfo(exe,
                "-v error -count_frames -select_streams v:0 -show_entries stream=width,height,nb_read_frames -of csv=p=0 \"" + file + "\"")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            Process p;
            try { p = Process.Start(info); }
            catch (Exception) { Assert.Ignore("ffprobe not found (set TFORGE_FFMPEG_DIR)"); return null; }
            var output = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit();
            return output;
        }
    }
}
