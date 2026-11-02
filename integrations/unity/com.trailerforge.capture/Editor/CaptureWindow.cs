using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace TrailerForge.Capture.Editor
{
    /// <summary>Shows the capture list exported from TrailerForge: groups, codes, instructions, hints and takes so far.</summary>
    public class CaptureWindow : EditorWindow
    {
        const string PackKey = "TrailerForge.Capture.PackPath";
        const string OutputKey = "TrailerForge.Capture.OutputFolder";
        const string FormatKey = "TrailerForge.Capture.Format";
        const string HudKey = "TrailerForge.Capture.Hud";
        const string ManualKey = "TrailerForge.Capture.Manual";
        const string CameraKey = "TrailerForge.Capture.CameraTag";

        enum HudChoice { FromPack, On, Off }

        string packPath;
        string outputFolder;
        CapturePack pack;
        string error;
        Dictionary<string, int> takes = new Dictionary<string, int>();
        Vector2 scroll;
        readonly HashSet<string> open = new HashSet<string>();
        TakeFormat format;
        HudChoice hud;
        bool manual;
        string cameraTag;
        ShotQueue queue;
        static bool Busy => TakeRun.Current != null && TakeRun.Current.State == TakeState.Recording;
        string lastResult;
        MessageType lastResultType;

        [MenuItem("Window/TrailerForge/Capture")]
        public static void Open() => GetWindow<CaptureWindow>("TrailerForge Capture");

        void OnEnable()
        {
            packPath = EditorPrefs.GetString(PackKey, "");
            outputFolder = EditorPrefs.GetString(OutputKey, "");
            format = (TakeFormat)EditorPrefs.GetInt(FormatKey, (int)TakeFormat.ProRes422HQ);
            hud = (HudChoice)EditorPrefs.GetInt(HudKey, (int)HudChoice.FromPack);
            manual = EditorPrefs.GetBool(ManualKey, false);
            cameraTag = EditorPrefs.GetString(CameraKey, "");
            Reload();
        }

        void Update()
        {
            if (Busy || (queue != null && queue.Running)) Repaint();
        }

        void Reload()
        {
            error = null;
            pack = null;
            if (!string.IsNullOrEmpty(packPath))
            {
                try { pack = CapturePackReader.ReadFile(packPath); }
                catch (CapturePackException e) { error = e.Message; }
            }
            takes = TakeCounter.Count(outputFolder);
        }

        void OnGUI()
        {
            DrawSetup();
            DrawRecordOptions();
            DrawTakeStatus();
            DrawQueue();
            if (error != null) EditorGUILayout.HelpBox(error, MessageType.Error);
            if (pack == null)
            {
                if (error == null)
                    EditorGUILayout.HelpBox(
                        "Choose the capture-pack.json exported from TrailerForge (Capture tab, JSON).",
                        MessageType.Info);
                return;
            }
            DrawPack();
        }

        void DrawSetup()
        {
            EditorGUILayout.Space(4);
            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.LabelField("Capture pack", GUILayout.Width(90));
                EditorGUILayout.SelectableLabel(packPath, GUILayout.Height(18));
                if (GUILayout.Button("Choose…", GUILayout.Width(70)))
                {
                    var p = EditorUtility.OpenFilePanel("Capture pack", string.IsNullOrEmpty(packPath) ? "" : System.IO.Path.GetDirectoryName(packPath), "json");
                    if (!string.IsNullOrEmpty(p)) { packPath = p; EditorPrefs.SetString(PackKey, p); Reload(); }
                }
                if (GUILayout.Button("Reload", GUILayout.Width(60))) Reload();
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.LabelField("Recordings go to", GUILayout.Width(90));
                EditorGUILayout.SelectableLabel(outputFolder, GUILayout.Height(18));
                if (GUILayout.Button("Choose…", GUILayout.Width(70)))
                {
                    var p = EditorUtility.OpenFolderPanel("Recordings folder (a folder TrailerForge watches)", outputFolder, "");
                    if (!string.IsNullOrEmpty(p)) { outputFolder = p; EditorPrefs.SetString(OutputKey, p); Reload(); }
                }
                if (GUILayout.Button("Refresh", GUILayout.Width(60))) takes = TakeCounter.Count(outputFolder);
            }
            if (string.IsNullOrEmpty(outputFolder))
                EditorGUILayout.HelpBox("Pick the folder TrailerForge watches, so recordings are imported by shot code.", MessageType.Warning);
        }

        void DrawRecordOptions()
        {
            EditorGUI.BeginChangeCheck();
            using (new EditorGUILayout.HorizontalScope())
            {
                format = (TakeFormat)EditorGUILayout.EnumPopup("Format", format);
                hud = (HudChoice)EditorGUILayout.EnumPopup("HUD", hud);
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                manual = !EditorGUILayout.Toggle(new GUIContent("Stop after shot length", "Off: record until you press Stop."), !manual);
                cameraTag = EditorGUILayout.TextField(new GUIContent("Camera tag", "Empty records the main camera."), cameraTag);
            }
            if (EditorGUI.EndChangeCheck())
            {
                EditorPrefs.SetInt(FormatKey, (int)format);
                EditorPrefs.SetInt(HudKey, (int)hud);
                EditorPrefs.SetBool(ManualKey, manual);
                EditorPrefs.SetString(CameraKey, cameraTag);
            }
            if (!EditorApplication.isPlaying)
                EditorGUILayout.HelpBox("Enter Play Mode, set the shot up (or give it a set-up asset), then press Record on it.", MessageType.None);
            else if (pack != null && FindObjectsOfType<TrailerForgeShot>().Length > 0)
                using (new EditorGUI.DisabledScope(Busy || (queue != null && queue.Running) || string.IsNullOrEmpty(outputFolder)))
                    if (GUILayout.Button("Record all camera-only shots")) RecordAllCameraShots();
        }

        void DrawTakeStatus()
        {
            var rec = TakeRun.Current;
            if (rec != null && rec.State == TakeState.Recording)
            {
                if (rec.SettingUp)
                {
                    using (new EditorGUILayout.HorizontalScope(EditorStyles.helpBox))
                    {
                        EditorGUILayout.LabelField($"Setting up {rec.Request.Code}…", EditorStyles.boldLabel);
                        if (GUILayout.Button("Cancel", GUILayout.Width(60))) rec.Cancel();
                    }
                    return;
                }
                var target = rec.Request.FrameTarget;
                var seconds = (double)rec.FramesRecorded / rec.Request.Fps;
                var text = target > 0
                    ? $"Recording {rec.Request.Code}: {seconds:0.0} of {rec.Request.Seconds:0.#} s"
                    : $"Recording {rec.Request.Code}: {seconds:0.0} s";
                using (new EditorGUILayout.HorizontalScope(EditorStyles.helpBox))
                {
                    EditorGUILayout.LabelField(text, EditorStyles.boldLabel);
                    if (GUILayout.Button("Stop", GUILayout.Width(60))) rec.Stop();
                    if (GUILayout.Button("Cancel", GUILayout.Width(60))) rec.Cancel();
                }
                if (target > 0)
                    EditorGUI.ProgressBar(EditorGUILayout.GetControlRect(false, 6), Mathf.Clamp01((float)rec.FramesRecorded / target), "");
            }
            else if (lastResult != null)
            {
                EditorGUILayout.HelpBox(lastResult, lastResultType);
            }
        }

        void Record(PackItem item)
        {
            var request = TakeRequest.FromPack(pack, item, outputFolder);
            request.Format = format;
            if (hud != HudChoice.FromPack) request.Hud = hud == HudChoice.On;
            if (manual) request.Seconds = 0;
            request.CameraTag = cameraTag ?? "";
            var shot = FindShot(item.code);
            try
            {
                var rec = TakeRun.Start(request, FindSetup(item.code), shot);
                rec.Done += OnTakeDone;
                lastResult = null;
            }
            catch (System.Exception e)
            {
                lastResult = e.Message;
                lastResultType = MessageType.Error;
            }
        }

        static TrailerForgeShot FindShot(string code) =>
            FindObjectsOfType<TrailerForgeShot>().FirstOrDefault(s => s.NormalizedCode == (code ?? "").ToUpperInvariant());

        static ShotSetup FindSetup(string code) =>
            AssetDatabase.FindAssets("t:ShotSetup")
                .Select(g => AssetDatabase.LoadAssetAtPath<ShotSetup>(AssetDatabase.GUIDToAssetPath(g)))
                .FirstOrDefault(s => s != null && string.Equals(s.code?.Trim(), code, System.StringComparison.OrdinalIgnoreCase));

        static void CreateSetup(PackItem item)
        {
            const string dir = "Assets/TrailerForge/Setups";
            System.IO.Directory.CreateDirectory(dir);
            var setup = CreateInstance<ShotSetup>();
            setup.code = item.code;
            AssetDatabase.CreateAsset(setup, $"{dir}/{item.code}.asset");
            AssetDatabase.SaveAssets();
            Selection.activeObject = setup;
        }

        void RecordAllCameraShots()
        {
            var q = new ShotQueue();
            foreach (var item in pack.Items)
            {
                var shot = FindShot(item.code);
                if (shot == null) continue;
                var req = TakeRequest.FromPack(pack, item, outputFolder);
                req.Format = format;
                if (hud != HudChoice.FromPack) req.Hud = hud == HudChoice.On;
                q.Add(req, shot, FindSetup(item.code));
            }
            if (q.Entries.Count == 0)
            {
                lastResult = "No TrailerForgeShot in the open scenes matches a shot code of this pack.";
                lastResultType = MessageType.Warning;
                return;
            }
            queue = q;
            q.Changed += _ => { takes = TakeCounter.Count(outputFolder); Repaint(); };
            q.Start();
        }

        void DrawQueue()
        {
            if (queue == null) return;
            using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
            {
                EditorGUILayout.LabelField(queue.Running ? $"Camera shots: {Mathf.Max(queue.Index, 0) + 1} of {queue.Entries.Count}" : "Camera shots", EditorStyles.boldLabel);
                foreach (var e in queue.Entries)
                {
                    var state = e.Run == null ? "waiting" : e.Run.State == TakeState.Recording ? "recording" : e.Run.State.ToString().ToLowerInvariant();
                    EditorGUILayout.LabelField($"{e.Request.Code}  {state}" + (e.Run?.Error != null ? " — " + e.Run.Error : ""), EditorStyles.miniLabel);
                }
                if (queue.LastError != null) EditorGUILayout.HelpBox(queue.LastError, MessageType.Error);
                if (queue.Running && GUILayout.Button("Cancel the rest")) queue.Cancel();
            }
        }

        void OnTakeDone(TakeRun rec)
        {
            switch (rec.State)
            {
                case TakeState.Finished:
                    lastResult = $"Saved {System.IO.Path.GetFileName(rec.FilePath)} ({rec.Sidecar.seconds:0.##} s)." +
                                 (rec.Warning != null ? " " + rec.Warning : "");
                    lastResultType = rec.Warning != null ? MessageType.Warning : MessageType.Info;
                    break;
                case TakeState.Cancelled:
                    lastResult = "Take cancelled; nothing was saved.";
                    lastResultType = MessageType.Info;
                    break;
                default:
                    lastResult = rec.Error;
                    lastResultType = MessageType.Error;
                    break;
            }
            takes = TakeCounter.Count(outputFolder);
            Repaint();
        }

        void DrawPack()
        {
            var s = pack.recording.settings;
            EditorGUILayout.LabelField(pack.project.name, EditorStyles.boldLabel);
            EditorGUILayout.LabelField(
                $"{pack.progress.done} of {pack.progress.total} shots done · {s.resolution.width}×{s.resolution.height} at {s.fps} fps · HUD {s.hud}");
            foreach (var a in pack.recording.advice.Where(a => a.severity == "warn"))
                EditorGUILayout.HelpBox(a.message, MessageType.Warning);

            scroll = EditorGUILayout.BeginScrollView(scroll);
            foreach (var group in pack.groups)
            {
                EditorGUILayout.Space(6);
                EditorGUILayout.LabelField($"{group.label}  ({group.done}/{group.total})", EditorStyles.boldLabel);
                if (!string.IsNullOrEmpty(group.setup)) EditorGUILayout.LabelField("Set up: " + group.setup, EditorStyles.wordWrappedLabel);
                foreach (var h in group.hints.debugCommands.Concat(group.hints.saveFiles))
                    EditorGUILayout.LabelField("• " + h.name + (h.detail.Length > 0 ? " — " + h.detail : ""), EditorStyles.wordWrappedMiniLabel);
                foreach (var item in group.items) DrawItem(item);
            }
            EditorGUILayout.EndScrollView();
        }

        void DrawItem(PackItem item)
        {
            takes.TryGetValue(item.code ?? "", out var n);
            var label = $"{item.code}  #{item.shotNumber} {item.title}  [{item.priority}]  {n} take{(n == 1 ? "" : "s")}{(item.done ? "  ✓" : "")}";
            var isOpen = open.Contains(item.slotId);
            bool now;
            using (new EditorGUILayout.HorizontalScope())
            {
                now = EditorGUILayout.Foldout(isOpen, label, true);
                var busy = Busy || (queue != null && queue.Running);
                using (new EditorGUI.DisabledScope(!EditorApplication.isPlaying || busy || string.IsNullOrEmpty(outputFolder)))
                    if (GUILayout.Button(new GUIContent("Record", "Record a take of this shot"), GUILayout.Width(64))) Record(item);
            }
            if (now != isOpen) { if (now) open.Add(item.slotId); else open.Remove(item.slotId); }
            if (!now) return;
            using (new EditorGUI.IndentLevelScope())
            {
                if (item.instruction.Length > 0) EditorGUILayout.LabelField(item.instruction, EditorStyles.wordWrappedLabel);
                if (item.framing.Length > 0) EditorGUILayout.LabelField("Framing: " + item.framing, EditorStyles.wordWrappedLabel);
                if (item.setup.Length > 0) EditorGUILayout.LabelField("Set up: " + item.setup, EditorStyles.wordWrappedLabel);
                EditorGUILayout.LabelField($"Record about {item.recordSeconds} s (cut {item.cutSeconds.min}–{item.cutSeconds.max} s) · HUD {item.hud}");
                if (item.notes.Length > 0) EditorGUILayout.LabelField("Notes: " + item.notes, EditorStyles.wordWrappedLabel);
                var setup = FindSetup(item.code);
                using (new EditorGUILayout.HorizontalScope())
                {
                    EditorGUILayout.ObjectField("Set-up", setup, typeof(ShotSetup), false);
                    if (setup == null && GUILayout.Button("Create", GUILayout.Width(60))) CreateSetup(item);
                }
                if (FindShot(item.code) != null) EditorGUILayout.LabelField("Camera-only shot: a TrailerForgeShot in the scene plays it.", EditorStyles.miniLabel);
            }
        }
    }
}
