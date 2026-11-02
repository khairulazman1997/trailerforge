# TrailerForge Capture (Unity)

Shows the capture list from TrailerForge inside the Unity Editor and, in later tasks, records each shot named with its shot code into a folder TrailerForge watches. Files only: no network, and TrailerForge never writes into your game project.

## Install

Package Manager → **+** → **Add package from disk…** → pick `package.json` in this folder. Unity needs Unity 2022.3 or newer and fetches `com.unity.nuget.newtonsoft-json` itself.

## Use

1. In TrailerForge, open the **Capture** tab and export the pack as **JSON** (`exports/capture/capture-pack.json`).
2. In Unity, open **Window → TrailerForge → Capture**.
3. Choose the pack file and the recordings folder. Add that same folder as a watched folder in TrailerForge so recordings are imported and matched by shot code.
4. The window lists every shot with its code, instruction, framing, set-up hints and how many takes are already in the folder. **Reload** re-reads the pack after you re-export.

A capture pack of another format or version is refused with a message instead of being guessed at.

## Tests

From the repository root: `pnpm test:unity` (EditMode, batch mode, on `integrations/unity/TestProject`). Set `TFORGE_UNITY` to the Unity executable if it is not in the Hub's default folder. This is not part of `pnpm check`.
