using System.Collections.Generic;
using Newtonsoft.Json;

namespace TrailerForge.Capture
{
    // The capture pack as TrailerForge exports it (format "trailerforge.capture-pack"). Only the
    // fields the package uses are read; unknown fields are ignored and missing ones keep defaults.

    public class PackHint
    {
        public string name = "";
        public string kind = "";
        public string detail = "";
    }

    public class PackSize
    {
        public int width;
        public int height;
    }

    public class PackRecordingSettings
    {
        public PackSize resolution = new PackSize { width = 1920, height = 1080 };
        public int fps = 60;
        public double bitrateMbps;
        public string codec = "";
        public string container = "";
        public string hud = "any";
        public bool hdr;
    }

    public class PackAdvice
    {
        public string code = "";
        public string severity = "info";
        public string message = "";
    }

    public class PackRecording
    {
        public PackRecordingSettings settings = new PackRecordingSettings();
        public string primaryPlatform;
        public List<PackAdvice> advice = new List<PackAdvice>();
    }

    public class PackSetup
    {
        public List<PackHint> debugCommands = new List<PackHint>();
        public List<PackHint> saveFiles = new List<PackHint>();
    }

    public class PackSeconds
    {
        public double min;
        public double ideal;
        public double max;
    }

    public class PackEntity
    {
        public string name = "";
        public string kind;
    }

    public class PackItem
    {
        public string slotId = "";
        public string code = "";
        public int shotNumber;
        public string section = "";
        public string title = "";
        public string purpose = "";
        public string priority = "must";
        public string status = "empty";
        public bool done;
        public string instruction = "";
        public string framing = "";
        public string setup = "";
        public string location = "";
        public string hud = "any";
        public PackSeconds cutSeconds = new PackSeconds();
        public double handleSeconds;
        public int recordSeconds;
        public List<string> alternates = new List<string>();
        public List<PackEntity> entities = new List<PackEntity>();
        public string notes = "";
        public int takes;
    }

    public class PackGroupHints
    {
        public List<PackHint> levels = new List<PackHint>();
        public List<PackHint> featured = new List<PackHint>();
        public List<PackHint> debugCommands = new List<PackHint>();
        public List<PackHint> saveFiles = new List<PackHint>();
    }

    public class PackTips
    {
        public string status = "";
        public List<string> tips = new List<string>();
        public List<string> risks = new List<string>();
    }

    public class PackGroup
    {
        public string key = "";
        public string label = "";
        public string location = "";
        public string setup = "";
        public string featured;
        public int total;
        public int done;
        public PackGroupHints hints = new PackGroupHints();
        public PackTips tips;
        public List<PackItem> items = new List<PackItem>();
    }

    public class PackProject
    {
        public string id = "";
        public string name = "";
    }

    public class PackProgress
    {
        public int total;
        public int done;
        public int todoRecordSeconds;
    }

    public class CapturePack
    {
        public string format = "";
        public int version;
        public PackProject project = new PackProject();
        public PackProgress progress = new PackProgress();
        public PackRecording recording = new PackRecording();
        public PackSetup setup = new PackSetup();
        public List<PackGroup> groups = new List<PackGroup>();

        [JsonIgnore]
        public IEnumerable<PackItem> Items
        {
            get
            {
                foreach (var g in groups)
                    foreach (var i in g.items)
                        yield return i;
            }
        }
    }
}
