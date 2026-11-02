using System;
using System.Linq;
using UnityEditor;
using UnityEngine.LowLevel;
using PlayerLoopTypes = UnityEngine.PlayerLoop;

namespace TrailerForge.Capture.Editor
{
    /// <summary>
    /// Runs callbacks at the start of PostLateUpdate: after every game script, animation and LateUpdate,
    /// before the frame is rendered (and recorded). Capture samples here; replay writes its poses here, last.
    /// </summary>
    public static class LateHook
    {
        struct TrailerForgeLate { }

        static event Action Tick;
        static bool installed;

        public static void Add(Action callback)
        {
            Tick -= callback;
            Tick += callback;
            if (installed) return;
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            for (var i = 0; i < loop.subSystemList.Length; i++)
            {
                if (loop.subSystemList[i].type != typeof(PlayerLoopTypes.PostLateUpdate)) continue;
                var subs = loop.subSystemList[i].subSystemList.Where(x => x.type != typeof(TrailerForgeLate)).ToList();
                subs.Insert(0, new PlayerLoopSystem { type = typeof(TrailerForgeLate), updateDelegate = () => Tick?.Invoke() });
                loop.subSystemList[i].subSystemList = subs.ToArray();
            }
            PlayerLoop.SetPlayerLoop(loop);
            installed = true;
        }

        /// <summary>Safe to call from inside a callback: the loop itself is changed after this frame.</summary>
        public static void Remove(Action callback)
        {
            Tick -= callback;
            if (Tick == null) EditorApplication.delayCall += Uninstall;
        }

        static void Uninstall()
        {
            if (Tick != null || !installed) return;
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            for (var i = 0; i < loop.subSystemList.Length; i++)
            {
                if (loop.subSystemList[i].type != typeof(PlayerLoopTypes.PostLateUpdate)) continue;
                loop.subSystemList[i].subSystemList = loop.subSystemList[i].subSystemList.Where(x => x.type != typeof(TrailerForgeLate)).ToArray();
            }
            PlayerLoop.SetPlayerLoop(loop);
            installed = false;
        }
    }
}
