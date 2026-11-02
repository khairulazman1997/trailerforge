using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using Newtonsoft.Json;
using UnityEngine;

namespace TrailerForge.Capture.Editor
{
    // A recorded performance ("play once, film many"): the motion of everything visible while the user played,
    // replayed later from other cameras, sizes and speeds. File layout (`.tfperf`):
    //   "TFPERF" (6 bytes) · version (uint16, little endian) · gzip stream of records
    // Each record starts with a tag byte. The stream begins with Meta and must end with End; a file without End
    // was cut off and is refused. Transforms are written only when they change, so still objects cost one sample.

    public enum PerfObjectKind : byte
    {
        /// <summary>Was in the scene when capture started; found again by its path.</summary>
        Scene = 0,
        /// <summary>Appeared during capture without the Spawned hook: comes back as a mesh stand-in, in world space.</summary>
        StandIn = 1,
        /// <summary>Root of an instance reported through TrailerForgeCapture.Spawned: re-instantiated from its prefab.</summary>
        Prefab = 2,
        /// <summary>A part inside a Prefab instance; Path is relative to that instance, Parent is its id.</summary>
        PrefabPart = 3,
    }

    public enum PerfEventKind : byte
    {
        Shown = 1,
        Hidden = 2,
        ParticlePlay = 3,
        ParticleStop = 4,
        AudioPlay = 5,
        Despawn = 6,
        FieldOfView = 7,
    }

    public class PerfObject
    {
        public int Id;
        public PerfObjectKind Kind;
        public string Path = "";
        public int Parent = -1;
        /// <summary>Samples are world position/rotation/scale (stand-ins and prefab roots) instead of local.</summary>
        public bool World;
        public bool IsCamera;
        public bool HasRenderer;
        /// <summary>Asset ids as "guid:localId" (stand-ins).</summary>
        public string Mesh = "";
        public List<string> Materials = new List<string>();
        public string Prefab = "";
        public int FirstFrame;
    }

    public struct PerfSample
    {
        public int Frame;
        public Vector3 Position;
        public Quaternion Rotation;
        public Vector3 Scale;
    }

    public struct PerfEvent
    {
        public int Frame;
        public int Object;
        public PerfEventKind Kind;
        /// <summary>FieldOfView: degrees. AudioPlay: start time in the clip.</summary>
        public float A;
        /// <summary>AudioPlay: volume.</summary>
        public float B;
        /// <summary>AudioPlay: pitch.</summary>
        public float C;
        /// <summary>ParticlePlay: random seed (0 when the system picked its own).</summary>
        public uint Seed;
        /// <summary>AudioPlay: clip asset id "guid:localId".</summary>
        public string Clip;
    }

    public struct PerfFrame
    {
        /// <summary>Game time since the capture started, seconds.</summary>
        public double Time;
        public float DeltaTime;
    }

    public class PerformanceMeta
    {
        public string id = "";
        public string code = "";
        public List<string> scenes = new List<string>();
        public string unityVersion = "";
        public string package = "";
    }

    public class Performance
    {
        public PerformanceMeta Meta = new PerformanceMeta();
        public readonly List<PerfFrame> Frames = new List<PerfFrame>();
        public readonly List<PerfObject> Objects = new List<PerfObject>();
        /// <summary>Per object id, its samples in frame order (only frames where it changed).</summary>
        public readonly Dictionary<int, List<PerfSample>> Samples = new Dictionary<int, List<PerfSample>>();
        public readonly List<PerfEvent> Events = new List<PerfEvent>();
        public readonly List<string> Warnings = new List<string>();

        public double Seconds => Frames.Count == 0 ? 0 : Frames[Frames.Count - 1].Time;

        /// <summary>The sample in effect at a frame (the last one written at or before it), or null before the first.</summary>
        public PerfSample? SampleAt(int objectId, int frame)
        {
            if (!Samples.TryGetValue(objectId, out var list) || list.Count == 0 || list[0].Frame > frame) return null;
            int lo = 0, hi = list.Count - 1;
            while (lo < hi)
            {
                var mid = (lo + hi + 1) / 2;
                if (list[mid].Frame <= frame) lo = mid; else hi = mid - 1;
            }
            return list[lo];
        }
    }

    public class PerformanceFormatException : Exception
    {
        public PerformanceFormatException(string message) : base(message) { }
    }

    public static class PerformanceFormat
    {
        public const string Extension = ".tfperf";
        public static readonly byte[] Magic = Encoding.ASCII.GetBytes("TFPERF");
        public const ushort Version = 1;

        internal const byte TagMeta = 0, TagFrame = 1, TagObject = 2, TagTransform = 3, TagEvent = 4, TagWarning = 5, TagEnd = 255;
        internal const byte HasPos = 1, HasRot = 2, HasScale = 4;
        internal const byte FlagWorld = 1, FlagCamera = 2, FlagRenderer = 4;
    }

    /// <summary>Streams a performance to disk. Not thread-safe; one writer per file.</summary>
    public class PerformanceWriter : IDisposable
    {
        readonly Stream file;
        readonly GZipStream zip;
        readonly BinaryWriter w;
        int frames;
        bool ended;

        public PerformanceWriter(string path, PerformanceMeta meta)
        {
            file = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
            file.Write(PerformanceFormat.Magic, 0, PerformanceFormat.Magic.Length);
            file.WriteByte((byte)(PerformanceFormat.Version & 0xff));
            file.WriteByte((byte)(PerformanceFormat.Version >> 8));
            zip = new GZipStream(file, System.IO.Compression.CompressionLevel.Fastest, leaveOpen: true);
            w = new BinaryWriter(zip, Encoding.UTF8, leaveOpen: true);
            w.Write(PerformanceFormat.TagMeta);
            w.Write(JsonConvert.SerializeObject(meta));
        }

        public int FrameCount => frames;

        public void Frame(double time, float deltaTime)
        {
            w.Write(PerformanceFormat.TagFrame);
            w.Write(time);
            w.Write(deltaTime);
            frames++;
        }

        public void Object(PerfObject o)
        {
            w.Write(PerformanceFormat.TagObject);
            w.Write(o.Id);
            w.Write((byte)o.Kind);
            w.Write(o.Path ?? "");
            w.Write(o.Parent);
            w.Write((byte)((o.World ? PerformanceFormat.FlagWorld : 0) | (o.IsCamera ? PerformanceFormat.FlagCamera : 0) |
                           (o.HasRenderer ? PerformanceFormat.FlagRenderer : 0)));
            w.Write(o.Mesh ?? "");
            w.Write(o.Materials.Count);
            foreach (var m in o.Materials) w.Write(m ?? "");
            w.Write(o.Prefab ?? "");
            w.Write(o.FirstFrame);
        }

        public void Transform(int id, Vector3? pos, Quaternion? rot, Vector3? scale)
        {
            w.Write(PerformanceFormat.TagTransform);
            w.Write(id);
            w.Write((byte)((pos.HasValue ? PerformanceFormat.HasPos : 0) | (rot.HasValue ? PerformanceFormat.HasRot : 0) |
                           (scale.HasValue ? PerformanceFormat.HasScale : 0)));
            if (pos.HasValue) { var p = pos.Value; w.Write(p.x); w.Write(p.y); w.Write(p.z); }
            if (rot.HasValue) { var r = rot.Value; w.Write(r.x); w.Write(r.y); w.Write(r.z); w.Write(r.w); }
            if (scale.HasValue) { var s = scale.Value; w.Write(s.x); w.Write(s.y); w.Write(s.z); }
        }

        public void Event(PerfEvent e)
        {
            w.Write(PerformanceFormat.TagEvent);
            w.Write(e.Object);
            w.Write((byte)e.Kind);
            switch (e.Kind)
            {
                case PerfEventKind.FieldOfView: w.Write(e.A); break;
                case PerfEventKind.ParticlePlay: w.Write(e.Seed); break;
                case PerfEventKind.AudioPlay: w.Write(e.Clip ?? ""); w.Write(e.A); w.Write(e.B); w.Write(e.C); break;
            }
        }

        public void Warning(string message)
        {
            w.Write(PerformanceFormat.TagWarning);
            w.Write(message ?? "");
        }

        /// <summary>Writes the End record; without it the file is refused as incomplete.</summary>
        public void End()
        {
            if (ended) return;
            ended = true;
            w.Write(PerformanceFormat.TagEnd);
            w.Write(frames);
        }

        public void Dispose()
        {
            w.Flush();
            w.Dispose();
            zip.Dispose();
            file.Dispose();
        }
    }

    public static class PerformanceReader
    {
        public static Performance ReadFile(string path)
        {
            using (var f = File.OpenRead(path)) return Read(f);
        }

        public static Performance Read(Stream input)
        {
            var head = new byte[PerformanceFormat.Magic.Length + 2];
            if (input.Read(head, 0, head.Length) != head.Length) throw new PerformanceFormatException("This is not a TrailerForge performance file.");
            for (var i = 0; i < PerformanceFormat.Magic.Length; i++)
                if (head[i] != PerformanceFormat.Magic[i]) throw new PerformanceFormatException("This is not a TrailerForge performance file.");
            var version = head[6] | (head[7] << 8);
            if (version != PerformanceFormat.Version)
                throw new PerformanceFormatException($"This performance is format version {version}; this package reads version {PerformanceFormat.Version}.");

            var perf = new Performance();
            var frame = -1;
            var ended = false;
            using (var zip = new GZipStream(input, CompressionMode.Decompress, leaveOpen: true))
            using (var r = new BinaryReader(zip, Encoding.UTF8))
            {
                try
                {
                    if (r.ReadByte() != PerformanceFormat.TagMeta) throw new PerformanceFormatException("The performance file has no header.");
                    perf.Meta = JsonConvert.DeserializeObject<PerformanceMeta>(r.ReadString()) ?? new PerformanceMeta();
                    while (!ended)
                    {
                        var tag = r.ReadByte();
                        switch (tag)
                        {
                            case PerformanceFormat.TagFrame:
                                perf.Frames.Add(new PerfFrame { Time = r.ReadDouble(), DeltaTime = r.ReadSingle() });
                                frame++;
                                break;
                            case PerformanceFormat.TagObject:
                                perf.Objects.Add(ReadObject(r));
                                break;
                            case PerformanceFormat.TagTransform:
                                ReadTransform(r, perf, Math.Max(frame, 0));
                                break;
                            case PerformanceFormat.TagEvent:
                                perf.Events.Add(ReadEvent(r, Math.Max(frame, 0)));
                                break;
                            case PerformanceFormat.TagWarning:
                                perf.Warnings.Add(r.ReadString());
                                break;
                            case PerformanceFormat.TagEnd:
                                if (r.ReadInt32() != perf.Frames.Count) throw new PerformanceFormatException("The performance file is damaged (frame count does not match).");
                                ended = true;
                                break;
                            default:
                                throw new PerformanceFormatException($"The performance file is damaged (unknown record {tag}).");
                        }
                    }
                }
                catch (EndOfStreamException)
                {
                    throw new PerformanceFormatException("The performance file is incomplete: the capture did not finish.");
                }
                catch (InvalidDataException)
                {
                    throw new PerformanceFormatException("The performance file is damaged.");
                }
            }
            return perf;
        }

        static PerfObject ReadObject(BinaryReader r)
        {
            var o = new PerfObject
            {
                Id = r.ReadInt32(),
                Kind = (PerfObjectKind)r.ReadByte(),
                Path = r.ReadString(),
                Parent = r.ReadInt32(),
            };
            var flags = r.ReadByte();
            o.World = (flags & PerformanceFormat.FlagWorld) != 0;
            o.IsCamera = (flags & PerformanceFormat.FlagCamera) != 0;
            o.HasRenderer = (flags & PerformanceFormat.FlagRenderer) != 0;
            o.Mesh = r.ReadString();
            var n = r.ReadInt32();
            for (var i = 0; i < n; i++) o.Materials.Add(r.ReadString());
            o.Prefab = r.ReadString();
            o.FirstFrame = r.ReadInt32();
            return o;
        }

        static void ReadTransform(BinaryReader r, Performance perf, int frame)
        {
            var id = r.ReadInt32();
            var mask = r.ReadByte();
            if (!perf.Samples.TryGetValue(id, out var list)) perf.Samples[id] = list = new List<PerfSample>();
            // A sample carries forward what did not change.
            var prev = list.Count > 0 ? list[list.Count - 1] : new PerfSample { Rotation = Quaternion.identity, Scale = Vector3.one };
            var s = new PerfSample { Frame = frame, Position = prev.Position, Rotation = prev.Rotation, Scale = prev.Scale };
            if ((mask & PerformanceFormat.HasPos) != 0) s.Position = new Vector3(r.ReadSingle(), r.ReadSingle(), r.ReadSingle());
            if ((mask & PerformanceFormat.HasRot) != 0) s.Rotation = new Quaternion(r.ReadSingle(), r.ReadSingle(), r.ReadSingle(), r.ReadSingle());
            if ((mask & PerformanceFormat.HasScale) != 0) s.Scale = new Vector3(r.ReadSingle(), r.ReadSingle(), r.ReadSingle());
            if (list.Count > 0 && list[list.Count - 1].Frame == frame) list[list.Count - 1] = s; else list.Add(s);
        }

        static PerfEvent ReadEvent(BinaryReader r, int frame)
        {
            var e = new PerfEvent { Frame = frame, Object = r.ReadInt32(), Kind = (PerfEventKind)r.ReadByte() };
            switch (e.Kind)
            {
                case PerfEventKind.FieldOfView: e.A = r.ReadSingle(); break;
                case PerfEventKind.ParticlePlay: e.Seed = r.ReadUInt32(); break;
                case PerfEventKind.AudioPlay: e.Clip = r.ReadString(); e.A = r.ReadSingle(); e.B = r.ReadSingle(); e.C = r.ReadSingle(); break;
            }
            return e;
        }
    }
}
