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

## M10 EffectCraft: Windows items (revised 2026-11-09: the installed copy, no pin)

TrailerForge uses the EffectCraft you installed (found in `C:\Program Files\EffectCraft` or on PATH; `TFORGE_EFFECTCRAFT` overrides, empty switches it off). Nothing is downloaded or bundled for it.

**Done 2026-11-09 with EffectCraft 0.22.0 on Windows:** items 1, 2 and 4 except the Lottie example: contract tests incl. the real-CLI render (byte-identical twice), the three templates built and committed, title-reveal rendered at 1920×1080 and exactly 1280×720 RGBA and looked at, `m10-flow.test.ts` on the real CLI (the AI's commands accepted, export identical twice, no network), the spike script's render, determinism (1 vs 4 threads), alpha and PNG checks (its template step uses Linux `/tmp` paths and `bc`/`strace`, so it fails on Windows; the template build covers it). Still open: item 3 in the app (Describe an effect with your own key, Open in EffectCraft round trip, Lottie, reference clip), item 5 after the next EffectCraft update. (`e2e/effectcraft.spec.ts` now passes on Windows: its "Effect Ember burst" locator also matched the proposal card, "Proposed effect Ember burst"; fixed with `exact: true`.)

1. Contract tests against the real CLI: `$env:TFORGE_EFFECTCRAFT="C:\Program Files\EffectCraft\effectcraft-cli.exe"; pnpm --filter @trailerforge/effectcraft test` (the real-CLI test renders a small scene twice and compares the frames; skipped without the variable). Also the spike script (`docs/spikes/effectcraft-spike.sh`, Git Bash) with `CLI=<path>`.
2. **Generate the three templates** (10.4): `pnpm build`, then with `TFORGE_EFFECTCRAFT` set, `pnpm --filter @trailerforge/effectcraft build:templates`, and commit `packages/effectcraft/templates/`. If a command's property path is wrong the script stops with EffectCraft's message: fix `templateAuthoringCommands`. Render one title at 1080p and at 720p and look at both; `package:check` requires `templates/manifest.json`. Templates made with one version are offered to that version and newer ones; rebuild them when an EffectCraft update cannot read them.
3. **M10 end to end** (10.7): `pnpm --filter @trailerforge/engine exec vitest run src/m10-flow.test.ts src/effectcraft-*.test.ts` (stub CLI) plus a real-CLI run; then in the app: Setup shows "EffectCraft <version> is ready (<path>)"; Graphics → Describe an effect with your own Anthropic key; add it to the cut; export twice and compare the files; _Save a copy to edit in EffectCraft_, open it in the EffectCraft app, change the text, _Use the edited copy_; a Lottie `.json` as an example; a reference clip with and without the pictures ticked.
4. Things only the real CLI can confirm: `file.importLottie` and `layer.addItem` (the nesting of an example), the shape of `run --json` output, `--resolution 0.6667` giving exactly 1280×720, the property paths in the prompt and in the template script, and that frames are byte-identical across runs.
5. After an EffectCraft update: Setup shows the new version (with a note if it is not the tested one), approvals of versions with EffectCraft graphics show "EffectCraft was updated … since this was approved", and the next export re-renders them.
6. **Effect showcase** (2026-11-08, richer AI effects): the AI may now use blend modes, track mattes, masks, text animators and presets, layer styles and the built-in presets. The worked examples the prompt shows it (`packages/effectcraft/src/effect-examples.ts`: a light sweep through a title, a per-letter blur reveal with a feathered wipe, an ember haze behind an outline-then-fill title) were checked on EffectCraft 0.22.0 on 2026-11-10: all three build and render identically twice, and so do all 21 presets the prompt names (`layer.style.*` take only `{layers}`, so the outline uses `layer.newText`'s stroke parameters; `prop.editGradient` opens an interactive editor and was dropped from the allowlist). Rerun it after an EffectCraft update. In PowerShell from the repo root:

   ```powershell
   $env:TFORGE_EFFECTCRAFT="C:\Program Files\EffectCraft\effectcraft-cli.exe"; node packages/effectcraft/scripts/showcase.mjs effectcraft-showcase --presets
   ```

   It builds the package (turbo, cached; `--no-build` skips it), then writes to `effectcraft-showcase\`: five PNG frames per example (`<example>_<t>s.png`), the `.ecproj` files (open them in EffectCraft), `<example>.error.txt` for any that EffectCraft refused, `commands.txt` (which allowed commands this build has and how `commands --json` describes their parameters) and `summary.md` (built, deterministic: each is rendered twice and the frames compared; with `--presets`, the same for every preset the prompt names). Look at the frames: do they read as trailer graphics? Send back `summary.md`, `commands.txt` and any `.error.txt` so the examples and the prompt can be fixed. A preset marked not deterministic must be refused or its seed fixed (the render cache assumes same input, same frames).
