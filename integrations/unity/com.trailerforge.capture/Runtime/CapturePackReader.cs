using System;
using System.IO;
using Newtonsoft.Json;

namespace TrailerForge.Capture
{
    /// <summary>Raised when a capture pack cannot be used; the message is meant for the user.</summary>
    public class CapturePackException : Exception
    {
        public CapturePackException(string message) : base(message) { }
    }

    public static class CapturePackReader
    {
        public const string Format = "trailerforge.capture-pack";

        /// <summary>The pack version this package understands; another one is refused, not guessed at.</summary>
        public const int SupportedVersion = 1;

        public static CapturePack ReadFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                throw new CapturePackException("The capture pack was not found: " + path);
            return Parse(File.ReadAllText(path));
        }

        public static CapturePack Parse(string json)
        {
            CapturePack pack;
            try
            {
                pack = JsonConvert.DeserializeObject<CapturePack>(json);
            }
            catch (JsonException e)
            {
                throw new CapturePackException("The file is not a readable capture pack: " + e.Message);
            }
            if (pack == null || pack.format != Format)
                throw new CapturePackException(
                    "This is not a TrailerForge capture pack. Export one from the Capture tab in TrailerForge (JSON).");
            if (pack.version != SupportedVersion)
                throw new CapturePackException(
                    "This capture pack is version " + pack.version + "; this package reads version " +
                    SupportedVersion + ". Update TrailerForge Capture or re-export the pack.");
            return pack;
        }
    }
}
