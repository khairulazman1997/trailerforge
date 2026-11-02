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

        string packPath;
        string outputFolder;
        CapturePack pack;
        string error;
        Dictionary<string, int> takes = new Dictionary<string, int>();
        Vector2 scroll;
        readonly HashSet<string> open = new HashSet<string>();

        [MenuItem("Window/TrailerForge/Capture")]
        public static void Open() => GetWindow<CaptureWindow>("TrailerForge Capture");

        void OnEnable()
        {
            packPath = EditorPrefs.GetString(PackKey, "");
            outputFolder = EditorPrefs.GetString(OutputKey, "");
            Reload();
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
            var now = EditorGUILayout.Foldout(isOpen, label, true);
            if (now != isOpen) { if (now) open.Add(item.slotId); else open.Remove(item.slotId); }
            if (!now) return;
            using (new EditorGUI.IndentLevelScope())
            {
                if (item.instruction.Length > 0) EditorGUILayout.LabelField(item.instruction, EditorStyles.wordWrappedLabel);
                if (item.framing.Length > 0) EditorGUILayout.LabelField("Framing: " + item.framing, EditorStyles.wordWrappedLabel);
                if (item.setup.Length > 0) EditorGUILayout.LabelField("Set up: " + item.setup, EditorStyles.wordWrappedLabel);
                EditorGUILayout.LabelField($"Record about {item.recordSeconds} s (cut {item.cutSeconds.min}–{item.cutSeconds.max} s) · HUD {item.hud}");
                if (item.notes.Length > 0) EditorGUILayout.LabelField("Notes: " + item.notes, EditorStyles.wordWrappedLabel);
            }
        }
    }
}
