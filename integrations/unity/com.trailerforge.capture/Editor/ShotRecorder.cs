using System;
using System.IO;
using UnityEditor.Recorder;
using UnityEditor.Recorder.Encoder;
using UnityEditor.Recorder.Input;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace TrailerForge.Capture.Editor
{
    public enum TakeFormat
    {
        /// <summary>Apple ProRes 422 HQ in a .mov (Windows and macOS).</summary>
        ProRes422HQ,
        /// <summary>H.264 in an .mp4 at high quality.</summary>
        H264,
    }

    /// <summary>Everything one take needs. <see cref="FromPack"/> fills it from the capture pack.</summary>
    public class TakeRequest
    {
        public string Code = "";
        public string SlotId = "";
        public string ProjectId = "";
        public string OutputFolder = "";
        public int Width = 1920;
        public int Height = 1080;
        public int Fps = 60;
        /// <summary>Length in seconds; 0 or less records until stopped by hand.</summary>
        public double Seconds;
        public bool Hud;
        public TakeFormat Format = TakeFormat.ProRes422HQ;
        /// <summary>Camera tag to record; empty = the main camera.</summary>
        public string CameraTag = "";
        /// <summary>With the HUD off, also hide the "UI" layer from the camera (world- and camera-space canvases).</summary>
        public bool HideUiLayer = true;
        public bool Audio = true;
        /// <summary>How the take is made: "live", "camera" or "replay" (written to the sidecar).</summary>
        public string Level = "live";
        /// <summary>Playback speed of a replay (0.5 = half speed).</summary>
        public double Speed = 1;
        public string PerformanceId;
        /// <summary>Name of the camera for the sidecar; defaults to the tag or "main".</summary>
        public string CameraLabel;

        /// <summary>The pack's resolution and frame rate; HUD from the shot, else the pack (per-shot and "any" mean off);
        /// length = the shot's record seconds.</summary>
        public static TakeRequest FromPack(CapturePack pack, PackItem item, string outputFolder)
        {
            var s = pack.recording.settings;
            var hud = item.hud == "on" || item.hud == "off" ? item.hud : s.hud;
            return new TakeRequest
            {
                Code = item.code,
                SlotId = item.slotId,
                ProjectId = pack.project.id,
                OutputFolder = outputFolder,
                Width = s.resolution.width,
                Height = s.resolution.height,
                Fps = s.fps,
                Seconds = item.recordSeconds,
                Hud = hud == "on",
            };
        }

        public int FrameTarget => Seconds > 0 ? Math.Max(1, (int)Math.Round(Seconds * Fps)) : 0;
    }

    public enum TakeState { Recording, Finished, Cancelled, Failed }

    /// <summary>Records one take with Unity Recorder at a constant frame rate (the Recorder's movie encoders do not
    /// support variable rates; the frame-rate cap keeps a fast machine at real time). Needs Play Mode.</summary>
    public class ShotRecorder
    {
        public static ShotRecorder Current { get; private set; }

        public TakeRequest Request { get; }
        public TakeState State { get; private set; } = TakeState.Recording;
        public string Error { get; private set; }
        /// <summary>A note about the take, such as ProRes being unavailable here.</summary>
        public string Warning { get; private set; }
        /// <summary>The finished recording in the output folder.</summary>
        public string FilePath { get; private set; }
        public TakeSidecar Sidecar { get; private set; }
        public int Take { get; }
        public int FramesRecorded => State == TakeState.Recording ? Time.frameCount - startFrame : frames;
        public event Action<ShotRecorder> Done;

        readonly RecorderController controller;
        readonly RecorderControllerSettings controllerSettings;
        readonly MovieRecorderSettings movie;
        readonly string partialFile;
        readonly int startFrame;
        int frames;
        Camera hiddenUiCamera;
        int savedCullingMask;

        public static ShotRecorder Start(TakeRequest request)
        {
            if (!Application.isPlaying) throw new InvalidOperationException("Enter Play Mode first: takes are recorded while the game runs.");
            if (Current != null && Current.State == TakeState.Recording) throw new InvalidOperationException("A take is already recording.");
            if (string.IsNullOrWhiteSpace(request.OutputFolder)) throw new InvalidOperationException("Choose the recordings folder first.");
            if (string.IsNullOrWhiteSpace(request.Code)) throw new InvalidOperationException("This shot has no shot code; re-export the pack from TrailerForge.");
            Current = new ShotRecorder(request);
            return Current;
        }

        ShotRecorder(TakeRequest request)
        {
            Request = request;
            // Even sizes: ProRes 422 and H.264 refuse odd ones.
            request.Width -= request.Width % 2;
            request.Height -= request.Height % 2;
            Directory.CreateDirectory(request.OutputFolder);
            var partialDir = TakeFiles.PartialDir(request.OutputFolder);
            Directory.CreateDirectory(partialDir);
            Take = TakeFiles.NextTake(request.OutputFolder, request.Code);

            movie = ScriptableObject.CreateInstance<MovieRecorderSettings>();
            movie.name = "TrailerForge " + request.Code;
            movie.Enabled = true;
            movie.EncoderSettings = Encoder(request);
            movie.ImageInputSettings = new CameraInputSettings
            {
                Source = string.IsNullOrEmpty(request.CameraTag) ? ImageSource.MainCamera : ImageSource.TaggedCamera,
                CameraTag = request.CameraTag,
                OutputWidth = request.Width,
                OutputHeight = request.Height,
                CaptureUI = request.Hud,
            };
            movie.AudioInputSettings.PreserveAudio = request.Audio;
            movie.OutputFile = Path.Combine(partialDir, TakeFiles.BaseName(request.Code, Take));
            partialFile = movie.OutputFile + "." + movie.EncoderSettings.Extension;

            controllerSettings = ScriptableObject.CreateInstance<RecorderControllerSettings>();
            controllerSettings.AddRecorderSettings(movie);
            controllerSettings.FrameRate = request.Fps;
            controllerSettings.FrameRatePlayback = FrameRatePlayback.Constant;
            controllerSettings.CapFrameRate = true;
            if (request.FrameTarget > 0) controllerSettings.SetRecordModeToFrameInterval(0, request.FrameTarget - 1);
            else controllerSettings.SetRecordModeToManual();

            if (!request.Hud && request.HideUiLayer) HideUiLayer(request);

            controller = new RecorderController(controllerSettings);
            controller.PrepareRecording();
            startFrame = Time.frameCount;
            if (!controller.StartRecording())
            {
                Fail("Unity Recorder did not start; see the Console for its reason.");
                return;
            }
            UnityEditor.EditorApplication.update += Tick;
            UnityEditor.EditorApplication.playModeStateChanged += OnPlayMode;
        }

        TakeFormat chosenFormat;

        IEncoderSettings Encoder(TakeRequest r)
        {
            chosenFormat = r.Format;
            if (r.Format == TakeFormat.ProRes422HQ)
            {
                var prores = new ProResEncoderSettings { Format = ProResEncoderSettings.OutputFormat.ProRes422HQ };
                if (prores.SupportsCurrentPlatform()) return prores;
                Warning = "ProRes is not available on this platform; recorded H.264 instead.";
                chosenFormat = TakeFormat.H264;
            }
            return new CoreEncoderSettings
            {
                Codec = CoreEncoderSettings.OutputCodec.MP4,
                EncodingQuality = CoreEncoderSettings.VideoEncodingQuality.High,
            };
        }

        void HideUiLayer(TakeRequest r)
        {
            var layer = LayerMask.NameToLayer("UI");
            if (layer < 0) return;
            Camera cam = null;
            if (string.IsNullOrEmpty(r.CameraTag)) cam = Camera.main;
            else
            {
                var go = GameObject.FindWithTag(r.CameraTag);
                if (go != null) cam = go.GetComponent<Camera>();
            }
            if (cam == null) return;
            hiddenUiCamera = cam;
            savedCullingMask = cam.cullingMask;
            cam.cullingMask &= ~(1 << layer);
        }

        void Tick()
        {
            if (State == TakeState.Recording && !controller.IsRecording()) Finish(true);
        }

        void OnPlayMode(UnityEditor.PlayModeStateChange change)
        {
            // Leaving Play Mode ends the take and keeps what was recorded.
            if (change == UnityEditor.PlayModeStateChange.ExitingPlayMode && State == TakeState.Recording) Finish(true);
        }

        /// <summary>Ends the take now and keeps it.</summary>
        public void Stop()
        {
            if (State == TakeState.Recording) Finish(true);
        }

        /// <summary>Ends the take and leaves nothing behind.</summary>
        public void Cancel()
        {
            if (State == TakeState.Recording) Finish(false);
        }

        void Finish(bool keep)
        {
            UnityEditor.EditorApplication.update -= Tick;
            UnityEditor.EditorApplication.playModeStateChanged -= OnPlayMode;
            frames = Request.FrameTarget > 0 && !controller.IsRecording()
                ? Request.FrameTarget
                : Time.frameCount - startFrame;
            if (controller.IsRecording()) controller.StopRecording();
            if (hiddenUiCamera != null) hiddenUiCamera.cullingMask = savedCullingMask;
            hiddenUiCamera = null;
            try
            {
                if (!keep)
                {
                    if (File.Exists(partialFile)) File.Delete(partialFile);
                    TakeFiles.CleanPartial(Request.OutputFolder);
                    State = TakeState.Cancelled;
                }
                else if (!File.Exists(partialFile) || frames <= 0)
                {
                    if (File.Exists(partialFile)) File.Delete(partialFile);
                    TakeFiles.CleanPartial(Request.OutputFolder);
                    Fail("Nothing was recorded.");
                    return;
                }
                else
                {
                    Sidecar = MakeSidecar();
                    FilePath = TakeFiles.Publish(partialFile, Request.OutputFolder, Sidecar);
                    State = TakeState.Finished;
                }
            }
            catch (Exception e)
            {
                Fail("The take could not be saved: " + e.Message);
                return;
            }
            Done?.Invoke(this);
        }

        TakeSidecar MakeSidecar() => new TakeSidecar
        {
            code = Request.Code,
            slotId = Request.SlotId,
            projectId = Request.ProjectId,
            take = Take,
            level = Request.Level,
            performanceId = Request.PerformanceId,
            frames = frames,
            seconds = Math.Round((double)frames / Request.Fps, 3),
            pass = new TakePass
            {
                camera = !string.IsNullOrEmpty(Request.CameraLabel) ? Request.CameraLabel : string.IsNullOrEmpty(Request.CameraTag) ? "main" : Request.CameraTag,
                hud = Request.Hud ? "on" : "off",
                speed = Request.Speed,
                width = Request.Width,
                height = Request.Height,
                fps = Request.Fps,
                codec = chosenFormat == TakeFormat.ProRes422HQ ? "prores-422-hq" : "h264",
            },
            unity = new TakeOrigin
            {
                version = Application.unityVersion,
                package = PackageVersion.Value,
                scene = SceneManager.GetActiveScene().path,
            },
        };

        void Fail(string message)
        {
            UnityEditor.EditorApplication.update -= Tick;
            UnityEditor.EditorApplication.playModeStateChanged -= OnPlayMode;
            if (hiddenUiCamera != null) hiddenUiCamera.cullingMask = savedCullingMask;
            hiddenUiCamera = null;
            State = TakeState.Failed;
            Error = message;
            Done?.Invoke(this);
        }
    }

    static class PackageVersion
    {
        public static readonly string Value =
            UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(PackageVersion).Assembly)?.version ?? "";
    }
}
