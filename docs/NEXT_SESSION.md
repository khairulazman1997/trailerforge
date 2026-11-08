# Next session (after Milestone 7: verify on Windows)

M1–M7 are built and green in the cloud container (Linux). What is left is verification on your Windows PC, which the container cannot do. Run the three checks below, then paste the block at the end into a fresh session with the results.

## 1. `pnpm check` on Windows

```bash
git pull
pnpm install
pnpm check
```

Run it in a normal terminal (or outside Claude Code's sandbox, so uv can reach PyPI). Note any failure with its output.

## 2. The browser tests on Windows

```bash
pnpm test:e2e
```

Set `TFORGE_CHROMIUM` to Chrome first (`C:/Program Files/Google/Chrome/Application/chrome.exe`) and have uv and FFmpeg on PATH. The new `e2e/whole-app.spec.ts` goes from "Try a demo" to an exported file and editor files. `e2e/a11y.spec.ts` checks every page and times a 200-shot project; its 200 ms limit was measured on a 4-core Linux container, so note the times it prints on your machine.

## 3. The installer smoke test

Follow "Deferred: desktop smoke checklist" below (build the installer, install it, Setup, demo, export, brand fonts, uninstall).

## Unity Capture in your own game (after Milestone 9)

The package is tested on the fixture project (`pnpm test:unity`: the package's Unity tests, then the whole flow from pack to rough cut). Your game is what it has not seen yet. In your Unity project, with a capture pack exported from your TrailerForge project:

1. Add the package from disk (README "Recording from Unity"). Note your Unity version, the render pipeline (Built-in, URP or HDRP), and any errors in the Console.
2. Open Window → TrailerForge → Capture, choose the pack and a recordings folder, and watch that folder in TrailerForge. Do any warnings show at the top (folder, HUD canvases)?
3. **Level 1**: Record one shot while playing. Does the file in the folder have the right length, size and frame rate? Is the HUD hidden when the pack says off? Does it attach to its shot in TrailerForge?
4. **Level 2**: make a set-up asset for a shot: a scene, the player position, and one of your own debug commands marked `[TrailerForgeSetup]`. Does it run before the take? Does a failing step say which step and why?
5. **Level 3**: give one shot a TrailerForgeShot with a short Timeline (with Cinemachine if you use it). Record it, then try Record all camera-only shots. Is the motion smooth at a locked frame rate, even if your machine is slow?
6. **Level 4**: Capture a busy shot (enemies spawning, particles, sound) for 10–20 s. Note the file size. Render it with the recorded camera at 1×, then with a placed camera (Tagged), at 0.5×, and at 4K.
   - Does anything move wrongly, flicker or go missing (spawned enemies come back as stand-ins unless you call `TrailerForgeCapture.Spawned`)?
   - Do your own scripts fight the replay?
   - Are the particle effects the same as when you played?
   - How long does a 4K render take?
7. Render all captured performances with one pass made to fail (a camera tag that does not exist), fix the tag, then press Run the rest again. Does it redo only that pass?
8. Build a rough cut with the Unity takes and note anything that feels wrong.

Paste your notes into the next session together with the prompt below (add "and my Unity Capture notes" to it).

## Prompt for the next session

---

Read `CLAUDE.md`, then the end of `docs/PLAN.md` (Milestones 7 and 9) and `docs/NEXT_SESSION.md`. M1–M7 and M9 are complete; this session handles what my Windows run found. Here are my results: <paste the failures, the times `a11y.spec.ts` printed, and the smoke checklist answers>. For each problem, find the cause, fix it with a test where one can run in the container, run `pnpm check` (and `pnpm test:e2e` for UI changes), commit and push to `main`, and log it in `docs/BUILD_LOG.md`. Say plainly what you could not verify. Do not start new features: the parked ideas in `docs/PLAN.md` ("Potential extensions") need my go-ahead first. Use Sonnet for fixes in UI, wiring and packaging, and Opus for anything in rendering determinism, crash recovery or schemas; tell me when to switch.

---

## Human review of a rough cut (the user, on a real machine)

The plan asks for a person to judge an M4 cut. With your own recordings and a music track: Footage tab → add the folder → attach → Cut tab → choose the music → Analyse → Build the cut → Play. Note what feels wrong (cuts that miss the beat, a dull stretch of a take, a shot too long or short) and send it back; the numbers the tests track are in `packages/cut/src/__snapshots__/metrics.test.ts.snap`. Also check on Windows: drag and drop onto the Footage tab, Choose folder…, and that the preview shows picture (headless test browsers cannot decode H.264).

## Deferred: desktop smoke checklist (run on Windows later)

Packaging (7.11) is verified here only as far as an unsigned `win-unpacked` folder goes; nothing was launched and no installer was built (NSIS needs Windows or wine).

1. `pnpm install`, `pnpm approve-builds` (allow electron), then `pnpm --filter @trailerforge/desktop package` (builds everything, stages a flat production copy, adds resvg's Windows binary and the pinned uv, runs electron-builder). Then `pnpm --filter @trailerforge/desktop package:check -- --installer` must print "Package complete" and name `TrailerForge-Setup-<version>.exe` in `apps/desktop/release/`.
2. Install it (unsigned: SmartScreen warns, choose "Run anyway"), start TrailerForge. The window opens, there is no File/Edit/View menu and no **Disconnect** button; path placeholders look like `C:\Games\...`.
3. Setup page: FFmpeg must be on PATH (install a full build); the analysis tools say "needs setup". Click **Create the analysis environment…**, read the disclosure (about 900 MB, an estimate), accept; it builds under the app's data folder (`%APPDATA%`). Check again: ready.
4. Projects → **Try a demo**: opens a project with a cut and two versions. Draft a review video and export one version.
5. Open or create a real project, generate a storyboard (Chat Handoff is fine), open the **Capture** tab; tick a shot, add a take and a note, undo once.
6. In "Share the pack", click **Write to the project folder**, then **Download Markdown**: does a Windows **Save As** dialog appear, and does the saved file open?
7. Add a logo and a font under **Brand**, then look at **Graphics**: the preview uses them. Export once more and check the card text is drawn with the brand font (this uses resvg's Windows binary).
8. Quit, reopen the project: everything is still there. Uninstall: the app folder goes, your projects stay.

Open for the installer: no icon yet (default Electron icon), no code signing, no auto-update.

## M10 EffectCraft: Windows items (added with task 10.2)

1. **Record the pinned EffectCraft hash.** The cloud container could not download the release (`effectcraft-0.9.2-windows-x64-portable.zip` returned 404 there; the asset name is taken from EffectCraft's `packaging/windows/package.ps1` and is unconfirmed). On Windows, download the v0.9.2 portable zip from the storytold/effectcraft release page, compare `Get-FileHash <zip> -Algorithm SHA256` with the digest the release page shows, and put it in `EC_SHA256` in `apps/desktop/scripts/package.mjs` (fix `EC_ZIP` if the name differs). Until then `package` stops with a message naming the zip's hash. `--effectcraft-zip=<file>` uses a zip you downloaded.
2. Then `package` and `package:check -- --installer`: the check now requires `resources/effectcraft/effectcraft-cli.exe` and its `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE`.
3. Contract tests against the real CLI: `$env:TFORGE_EFFECTCRAFT="<path>\effectcraft-cli.exe"; pnpm --filter @trailerforge/effectcraft test` (the real-CLI test renders a small scene twice and compares the frames; it is skipped without the variable). Also run the spike script (`docs/spikes/effectcraft-spike.sh`, Git Bash) with `CLI=<path>`.
4. **Generate the three templates** (10.4): with the real CLI, `pnpm build` then `$env:TFORGE_EFFECTCRAFT="<path>\effectcraft-cli.exe"; pnpm --filter @trailerforge/effectcraft build:templates`, and commit `packages/effectcraft/templates/`. If a command's property path is wrong the script stops with EffectCraft's message: fix `templateAuthoringCommands`. Then render one title at 1080p and at 720p and look at both; `package:check` requires `templates/manifest.json`.
5. **M10 end to end on Windows** (10.7): with the real CLI set, run `pnpm --filter @trailerforge/engine exec vitest run src/m10-flow.test.ts src/effectcraft-*.test.ts` with `TFORGE_EFFECTCRAFT` pointing at it instead of the stub (the tests use the stub today; swap the `effectcraft:` option or add a real-CLI variant), then in the installed app: Setup shows "EffectCraft 0.9.2 is ready"; Graphics → Describe an effect with your own Anthropic key; add it to the cut; export twice and compare the files; _Save a copy to edit in EffectCraft_, open it in the EffectCraft app, change the text, _Use the edited copy_; a Lottie `.json` as an example; a reference clip with and without the pictures ticked.
6. Things only the real CLI can confirm: `file.importLottie` and `layer.addItem` (the nesting of an example), the shape of `run --json` output, `--resolution 0.6667` giving exactly 1280×720, the property paths in the prompt and in the template script, and that frames are byte-identical on Windows across runs.
