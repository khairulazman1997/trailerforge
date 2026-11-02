using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace TrailerForge.Capture.Editor
{
    [Serializable]
    public class SetupStep
    {
        [Tooltip("A method marked [TrailerForgeSetup], by name (Class.Method or just Method).")]
        public string method = "";
        public string[] args = new string[0];
    }

    /// <summary>What to do before a shot is recorded: load a scene, put the player at a start point, run the game's own steps.</summary>
    [CreateAssetMenu(menuName = "TrailerForge/Shot set-up", fileName = "TF-XXXXX")]
    public class ShotSetup : ScriptableObject
    {
        [Tooltip("The shot code this set-up is for, such as TF-PX9B8.")]
        public string code = "";

        [Tooltip("Scene to load first (empty = stay in the current scene).")]
        public SceneAsset scene;

        public bool moveTarget;
        [Tooltip("Tag of the object to move to the start point.")]
        public string targetTag = "Player";
        public Vector3 startPosition;
        public Vector3 startEuler;

        [Tooltip("Run in order, after the scene is loaded and the target is placed.")]
        public List<SetupStep> steps = new List<SetupStep>();
    }

    /// <summary>The methods your game marked with <see cref="TrailerForgeSetupAttribute"/>.</summary>
    public static class SetupMethods
    {
        public static List<MethodInfo> All() =>
            TypeCache.GetMethodsWithAttribute<TrailerForgeSetupAttribute>()
                .Where(m => m.IsStatic)
                .OrderBy(m => m.DeclaringType?.FullName).ThenBy(m => m.Name)
                .ToList();

        public static string DisplayName(MethodInfo m) =>
            m.GetCustomAttribute<TrailerForgeSetupAttribute>()?.Name ?? (m.DeclaringType?.Name + "." + m.Name);

        /// <summary>Finds a step by "Class.Method", the attribute name, or the bare method name when that is unique.</summary>
        public static MethodInfo Find(string name)
        {
            var all = All();
            var hits = all.Where(m => m.DeclaringType?.Name + "." + m.Name == name || m.DeclaringType?.FullName + "." + m.Name == name
                                      || m.GetCustomAttribute<TrailerForgeSetupAttribute>()?.Name == name).ToList();
            if (hits.Count == 0) hits = all.Where(m => m.Name == name).ToList();
            if (hits.Count == 0) throw new InvalidOperationException($"No set-up step named \"{name}\". Mark a static method with [TrailerForgeSetup].");
            if (hits.Count > 1) throw new InvalidOperationException($"More than one set-up step is named \"{name}\"; use Class.Method.");
            return hits[0];
        }

        public static object[] Convert(MethodInfo m, string[] args)
        {
            var ps = m.GetParameters();
            args = args ?? new string[0];
            if (args.Length > ps.Length)
                throw new InvalidOperationException($"{m.Name} takes {ps.Length} argument(s) but {args.Length} were given.");
            var values = new object[ps.Length];
            for (var i = 0; i < ps.Length; i++)
            {
                var type = ps[i].ParameterType;
                if (i >= args.Length)
                {
                    if (!ps[i].HasDefaultValue) throw new InvalidOperationException($"{m.Name} needs a value for \"{ps[i].Name}\".");
                    values[i] = ps[i].DefaultValue;
                    continue;
                }
                try
                {
                    values[i] = type.IsEnum ? Enum.Parse(type, args[i], true)
                        : type == typeof(bool) ? ParseBool(args[i])
                        : System.Convert.ChangeType(args[i], type, CultureInfo.InvariantCulture);
                }
                catch (Exception e) when (e is FormatException || e is ArgumentException || e is InvalidCastException || e is OverflowException)
                {
                    throw new InvalidOperationException($"\"{args[i]}\" is not a valid {type.Name} for \"{ps[i].Name}\" of {m.Name}.");
                }
            }
            return values;
        }

        static bool ParseBool(string s)
        {
            switch (s.Trim().ToLowerInvariant())
            {
                case "1": case "true": case "yes": case "on": return true;
                case "0": case "false": case "no": case "off": return false;
            }
            throw new FormatException(s);
        }
    }

    /// <summary>Runs IEnumerators from the editor loop: yield null (a frame), nested IEnumerators, CustomYieldInstruction, AsyncOperation.</summary>
    public class Routine
    {
        readonly Stack<IEnumerator> stack = new Stack<IEnumerator>();
        object waiting;

        public Routine(IEnumerator root) => stack.Push(root);

        /// <summary>Advances one step; false when finished. Exceptions of the routine propagate.</summary>
        public bool Step()
        {
            if (waiting is CustomYieldInstruction c && c.keepWaiting) return true;
            if (waiting is AsyncOperation a && !a.isDone) return true;
            waiting = null;
            while (stack.Count > 0)
            {
                var top = stack.Peek();
                if (!top.MoveNext()) { stack.Pop(); continue; }
                var y = top.Current;
                switch (y)
                {
                    case null: return true;
                    case CustomYieldInstruction cy: waiting = cy; return true;
                    case IEnumerator nested: stack.Push(nested); continue;
                    case AsyncOperation ao: waiting = ao; return true;
                    default: throw new InvalidOperationException("Unsupported yield (" + y.GetType().Name + "); yield null, an IEnumerator, WaitForSecondsRealtime or an AsyncOperation.");
                }
            }
            return false;
        }
    }

    public static class SetupRunner
    {
        /// <summary>Everything a set-up asset says, as one routine. Throws (with a message for the user) on the first step that fails.</summary>
        public static IEnumerator Run(ShotSetup setup)
        {
            if (setup.scene != null)
            {
                var path = AssetDatabase.GetAssetPath(setup.scene);
                var load = EditorSceneManager.LoadSceneAsyncInPlayMode(path, new LoadSceneParameters(LoadSceneMode.Single));
                yield return load;
                yield return null;
            }
            if (setup.moveTarget) MoveTarget(setup);
            for (var i = 0; i < setup.steps.Count; i++)
            {
                var step = setup.steps[i];
                IEnumerator running = null;
                try
                {
                    var m = SetupMethods.Find(step.method);
                    var result = m.Invoke(null, SetupMethods.Convert(m, step.args));
                    running = result as IEnumerator;
                }
                catch (Exception e)
                {
                    var inner = e is TargetInvocationException t && t.InnerException != null ? t.InnerException : e;
                    throw new InvalidOperationException($"Set-up step {i + 1} ({step.method}) failed: {inner.Message}");
                }
                if (running != null) yield return running;
            }
        }

        static void MoveTarget(ShotSetup setup)
        {
            GameObject go;
            try { go = GameObject.FindWithTag(setup.targetTag); }
            catch (UnityException) { throw new InvalidOperationException($"The tag \"{setup.targetTag}\" does not exist."); }
            if (go == null) throw new InvalidOperationException($"No object tagged \"{setup.targetTag}\" to move to the start point.");
            var cc = go.GetComponent<CharacterController>();
            if (cc != null) cc.enabled = false;
            go.transform.SetPositionAndRotation(setup.startPosition, Quaternion.Euler(setup.startEuler));
            var rb = go.GetComponent<Rigidbody>();
            if (rb != null && !rb.isKinematic) { rb.velocity = Vector3.zero; rb.angularVelocity = Vector3.zero; }
            if (cc != null) cc.enabled = true;
        }
    }
}
