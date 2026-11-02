using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json;

namespace TrailerForge.Capture
{
    /// <summary>What a take was recorded with, written next to it as <c>&lt;take&gt;.tfshot.json</c>.</summary>
    public class TakeSidecar
    {
        public const string FormatName = "trailerforge.unity-take";
        public const int CurrentVersion = 1;

        public string format = FormatName;
        public int version = CurrentVersion;
        public string code = "";
        public string slotId = "";
        public string projectId = "";
        public int take;
        /// <summary>File name of the recording, next to this file.</summary>
        public string file = "";
        /// <summary>How it was made: "live" (played), later also "camera" and "replay".</summary>
        public string level = "live";
        public TakePass pass = new TakePass();
        public int frames;
        public double seconds;
        public string performanceId;
        public TakeOrigin unity = new TakeOrigin();
    }

    public class TakePass
    {
        public string camera = "";
        public string hud = "off";
        public double speed = 1;
        public int width;
        public int height;
        public int fps;
        public string codec = "";
    }

    public class TakeOrigin
    {
        public string version = "";
        public string package = "";
        public string scene = "";
    }

    /// <summary>Names and moves take files. Takes are written in a hidden <c>.tfpartial</c> folder and renamed into
    /// the output folder only when finished, so TrailerForge (which skips dot folders) never imports half a file.</summary>
    public static class TakeFiles
    {
        public const string PartialFolder = ".tfpartial";
        public const string SidecarSuffix = ".tfshot.json";
        static readonly Regex TakeRe = new Regex("_take(\\d{1,3})(?![0-9])", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        public static string BaseName(string code, int take) => code + "_take" + take.ToString("00");

        public static string PartialDir(string folder) => Path.Combine(folder, PartialFolder);

        public static string SidecarPath(string takeFile) =>
            Path.Combine(Path.GetDirectoryName(takeFile) ?? "", Path.GetFileNameWithoutExtension(takeFile) + SidecarSuffix);

        /// <summary>One more than the highest take number already used for the code (by a recording or a sidecar).</summary>
        public static int NextTake(string folder, string code)
        {
            var max = 0;
            foreach (var file in Files(folder))
            {
                var name = Path.GetFileName(file);
                if (!name.StartsWith(code, StringComparison.OrdinalIgnoreCase)) continue;
                var m = TakeRe.Match(name);
                if (m.Success) max = Math.Max(max, int.Parse(m.Groups[1].Value));
            }
            return max + 1;
        }

        /// <summary>Every file under the folder, skipping dot folders and dot files.</summary>
        public static IEnumerable<string> Files(string folder)
        {
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) yield break;
            foreach (var f in Directory.EnumerateFiles(folder))
                if (!Path.GetFileName(f).StartsWith(".")) yield return f;
            foreach (var d in Directory.EnumerateDirectories(folder))
            {
                if (Path.GetFileName(d).StartsWith(".")) continue;
                foreach (var f in Files(d)) yield return f;
            }
        }

        /// <summary>Moves a finished take from the partial folder into the output folder: the sidecar first (so it is
        /// there when the recording appears), then the recording. Returns the final recording path.</summary>
        public static string Publish(string partialFile, string folder, TakeSidecar sidecar)
        {
            var name = Path.GetFileName(partialFile);
            var dest = Path.Combine(folder, name);
            if (File.Exists(dest)) throw new IOException("A take with this name already exists: " + dest);
            sidecar.file = name;
            var sidecarDest = SidecarPath(dest);
            var sidecarTemp = Path.Combine(Path.GetDirectoryName(partialFile) ?? folder, Path.GetFileName(sidecarDest));
            File.WriteAllText(sidecarTemp, JsonConvert.SerializeObject(sidecar, Formatting.Indented));
            File.Move(sidecarTemp, sidecarDest);
            try
            {
                File.Move(partialFile, dest);
            }
            catch
            {
                File.Delete(sidecarDest);
                throw;
            }
            CleanPartial(folder);
            return dest;
        }

        /// <summary>Removes the partial folder when nothing is left in it.</summary>
        public static void CleanPartial(string folder)
        {
            var dir = PartialDir(folder);
            if (Directory.Exists(dir) && Directory.GetFileSystemEntries(dir).Length == 0) Directory.Delete(dir);
        }

        public static TakeSidecar ReadSidecar(string path) =>
            JsonConvert.DeserializeObject<TakeSidecar>(File.ReadAllText(path));
    }
}
