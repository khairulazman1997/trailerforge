using UnityEngine;
using UnityEngine.Playables;

namespace TrailerForge.Capture
{
    /// <summary>
    /// A hands-free shot: put this next to a <see cref="PlayableDirector"/> (a Timeline, with Cinemachine
    /// moving the camera if you use it) and give it the shot code from TrailerForge. TrailerForge Capture
    /// plays the Timeline and records it at a locked frame rate, so the footage is smooth at any size.
    /// </summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("TrailerForge/Shot")]
    public class TrailerForgeShot : MonoBehaviour
    {
        [Tooltip("The shot code from TrailerForge, such as TF-PX9B8.")]
        public string code = "";

        [Tooltip("The Timeline to play. Defaults to the one on this object.")]
        public PlayableDirector director;

        [Tooltip("The camera that films it. Empty = whatever the main camera shows (for example a Cinemachine brain).")]
        public Camera cameraToRecord;

        [Tooltip("Length in seconds. 0 = the Timeline's duration.")]
        public float secondsOverride;

        public string NormalizedCode => (code ?? "").Trim().ToUpperInvariant();

        public PlayableDirector Director => director != null ? director : GetComponent<PlayableDirector>();

        /// <summary>How long the shot runs: the override, else the Timeline's duration.</summary>
        public double Seconds
        {
            get
            {
                if (secondsOverride > 0) return secondsOverride;
                var d = Director;
                return d != null ? d.duration : 0;
            }
        }
    }
}
