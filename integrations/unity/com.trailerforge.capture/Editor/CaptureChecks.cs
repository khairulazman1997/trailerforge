using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;

namespace TrailerForge.Capture.Editor
{
    /// <summary>Problems that spoil a recording, found before it starts (each with a plain-words fix).</summary>
    public static class CaptureChecks
    {
        public class Problem
        {
            public string Message;
            /// <summary>Label of the one-click fix, or null when there is none.</summary>
            public string FixLabel;
            public Action Fix;
        }

        /// <summary>The output folder must exist and accept files; a missing one can be created.</summary>
        public static Problem OutputFolder(string folder)
        {
            if (string.IsNullOrWhiteSpace(folder))
                return new Problem { Message = "Pick the folder TrailerForge watches, so recordings are imported by shot code." };
            if (!Directory.Exists(folder))
                return new Problem
                {
                    Message = "The recordings folder does not exist: " + folder,
                    FixLabel = "Create it",
                    Fix = () => Directory.CreateDirectory(folder),
                };
            var probe = Path.Combine(folder, ".tf-write-test-" + Guid.NewGuid().ToString("N"));
            try
            {
                File.WriteAllText(probe, "");
                File.Delete(probe);
            }
            catch (Exception e)
            {
                return new Problem { Message = "TrailerForge cannot write to the recordings folder (" + e.Message + "). Choose another folder." };
            }
            return null;
        }

        /// <summary>With the HUD off, canvases that are drawn by the camera (screen space camera, world space) are only
        /// hidden when they sit on the "UI" layer. Lists the ones that are not.</summary>
        public static List<Canvas> HudCanvasesOutsideUiLayer()
        {
            var ui = LayerMask.NameToLayer("UI");
            if (ui < 0) return new List<Canvas>();
            return UnityEngine.Object.FindObjectsOfType<Canvas>()
                .Where(c => c.isRootCanvas && c.renderMode != RenderMode.ScreenSpaceOverlay && c.gameObject.layer != ui)
                .ToList();
        }

        public static Problem Hud(bool hudOn)
        {
            if (hudOn) return null;
            var canvases = HudCanvasesOutsideUiLayer();
            if (canvases.Count == 0) return null;
            return new Problem
            {
                Message = $"The HUD is off, but {canvases.Count} canvas(es) are drawn by the camera and are not on the \"UI\" layer, so they will show: " +
                          string.Join(", ", canvases.Take(3).Select(c => c.name)) + (canvases.Count > 3 ? "…" : "") + ".",
                FixLabel = "Select them",
                Fix = () => UnityEditor.Selection.objects = canvases.Select(c => (UnityEngine.Object)c.gameObject).ToArray(),
            };
        }
    }
}
