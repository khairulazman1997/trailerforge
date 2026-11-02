# TrailerForge Capture (Unity)

Shows the capture list from TrailerForge inside the Unity Editor and records each shot, named with its shot code, into a folder TrailerForge watches. Files only: no network, and TrailerForge never writes into your game project.

## Install

Package Manager → **+** → **Add package from disk…** → pick `package.json` in this folder. Unity needs Unity 2022.3 or newer and fetches its dependencies (Unity Recorder 4.0.3, Newtonsoft JSON) itself.

## Use

1. In TrailerForge, open the **Capture** tab and export the pack as **JSON** (`exports/capture/capture-pack.json`).
2. In Unity, open **Window → TrailerForge → Capture**.
3. Choose the pack file and the recordings folder. Add that same folder as a watched folder in TrailerForge so recordings are imported and matched by shot code.
4. The window lists every shot with its code, instruction, framing, set-up hints and how many takes are already in the folder. **Reload** re-reads the pack after you re-export.

## Record a take

1. Enter Play Mode and set the shot up (go to the place, load the save).
2. Press **Record** on the shot. Unity Recorder records the main camera (or the camera with the tag you set) at the pack's resolution and frame rate, and stops after the shot's record length (untick **Stop after shot length** to stop by hand).
3. While recording: **Stop** keeps the take, **Cancel** throws it away. Leaving Play Mode keeps what was recorded.

Takes are named `TF-XXXXX_take01.mov`, `TF-XXXXX_take02.mov`… and get a `TF-XXXXX_take01.tfshot.json` next to them with how they were recorded. They are written in a hidden `.tfpartial` folder first and moved in when finished, so TrailerForge never imports half a file.

- **Format:** ProRes 422 HQ (`.mov`, large files, best for editing) or H.264 (`.mp4`). ProRes falls back to H.264 where Unity Recorder does not offer it.
- **HUD:** from the pack (the shot's setting, else the pack's), or always on / off. With the HUD off, screen-space overlay UI is not captured and the "UI" layer is hidden from the camera for the take.
- **Frame rate:** Unity Recorder only records movies at a constant frame rate. The game is held to that rate: on a fast machine this is real time; if the machine cannot keep up, the game runs slower while you play, but the footage stays smooth.

In TrailerForge, a take with a sidecar is attached to its shot by the code inside the sidecar even if you rename the file, and is labelled with how it was recorded (camera, HUD, size). The Capture tab has a **Record in Unity** panel with the pack path and a button to watch the recordings folder.

A capture pack of another format or version is refused with a message instead of being guessed at.

## Tests

From the repository root: `pnpm test:unity` (EditMode, batch mode, on `integrations/unity/TestProject`). Set `TFORGE_UNITY` to the Unity executable if it is not in the Hub's default folder. This is not part of `pnpm check`.
