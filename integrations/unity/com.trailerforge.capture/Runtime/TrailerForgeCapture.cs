using System;
using UnityEngine;

namespace TrailerForge.Capture
{
    /// <summary>
    /// Calls a game can make so a recorded performance replays exactly. Cheap and safe to leave in
    /// shipping code: when nothing is capturing, they do nothing.
    /// </summary>
    public static class TrailerForgeCapture
    {
        /// <summary>Raised for <see cref="Spawned"/> while a performance is being captured (Editor only).</summary>
        public static event Action<GameObject, GameObject> OnSpawned;

        /// <summary>True while TrailerForge Capture is recording a performance.</summary>
        public static bool Listening => OnSpawned != null;

        /// <summary>
        /// Tell TrailerForge Capture that <paramref name="instance"/> was made from <paramref name="prefab"/>
        /// (call it right after <c>Instantiate</c>). Without it, a spawned object comes back in a replay as a
        /// stand-in built from its meshes, and spawned particle effects are missing.
        /// </summary>
        public static void Spawned(GameObject prefab, GameObject instance)
        {
            if (prefab == null || instance == null) return;
            OnSpawned?.Invoke(prefab, instance);
        }
    }
}
