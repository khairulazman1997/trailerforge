using UnityEngine;

// A game script of the fixture project (Assembly-CSharp): the replay tests reach it by reflection.
/// <summary>A game script that moves its object every frame (outside the TrailerForge namespace, so replay freezes it).</summary>
public class ReplayFixtureWanderer : MonoBehaviour
{
    public static int Updates;

    void Update()
    {
        Updates++;
        var t = Time.time;
        transform.localPosition = new Vector3(Mathf.Sin(t * 2) * 3, 1 + t * 0.5f, Mathf.Cos(t * 3));
        transform.localRotation = Quaternion.Euler(0, t * 90, t * 20);
    }

    void LateUpdate() => transform.localScale = Vector3.one * (1 + 0.5f * Mathf.Sin(Time.time));
}
