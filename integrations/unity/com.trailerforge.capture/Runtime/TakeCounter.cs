using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace TrailerForge.Capture
{
    /// <summary>Counts finished recordings per shot code in the output folder.</summary>
    public static class TakeCounter
    {
        static readonly Regex CodeRe = new Regex("TF-([0-9A-Za-z]{5})", RegexOptions.Compiled);
        static readonly HashSet<string> MediaExtensions =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".mov", ".mp4", ".mkv", ".webm", ".avi" };

        /// <summary>True for a file TrailerForge may import: a media file that is not a temporary name.</summary>
        public static bool IsFinishedTake(string path)
        {
            var name = Path.GetFileName(path);
            if (name.StartsWith(".") || name.StartsWith("~") || name.Contains(".tmp")) return false;
            return MediaExtensions.Contains(Path.GetExtension(name));
        }

        /// <summary>Shot code (upper case, "TF-XXXXX") to the number of finished takes carrying it.</summary>
        public static Dictionary<string, int> Count(string folder)
        {
            var counts = new Dictionary<string, int>();
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return counts;
            foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
            {
                if (!IsFinishedTake(file)) continue;
                var m = CodeRe.Match(Path.GetFileNameWithoutExtension(file));
                if (!m.Success) continue;
                var code = "TF-" + m.Groups[1].Value.ToUpperInvariant();
                counts.TryGetValue(code, out var n);
                counts[code] = n + 1;
            }
            return counts;
        }
    }
}
