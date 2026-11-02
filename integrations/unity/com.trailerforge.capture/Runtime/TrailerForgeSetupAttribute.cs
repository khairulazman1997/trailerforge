using System;

namespace TrailerForge.Capture
{
    /// <summary>
    /// Marks a static method of your game as a set-up step TrailerForge Capture can run before a take
    /// (load a save, spawn a boss, turn on god mode, set the time of day).
    /// Parameters may be string, int, float, double, bool or an enum; give them default values if a step
    /// can be called with fewer arguments. A step may return <c>IEnumerator</c> to wait: yield
    /// <c>null</c> (a frame), another <c>IEnumerator</c>, <c>WaitForSecondsRealtime</c> or any
    /// <c>CustomYieldInstruction</c> / <c>AsyncOperation</c>. A step that throws stops the take with its message.
    /// </summary>
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
    public sealed class TrailerForgeSetupAttribute : Attribute
    {
        /// <summary>The name shown in the set-up list; defaults to the method name.</summary>
        public string Name { get; }

        public TrailerForgeSetupAttribute(string name = null) => Name = name;
    }
}
