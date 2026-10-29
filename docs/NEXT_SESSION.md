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

## Prompt for the next session

---

Read `CLAUDE.md`, then the end of `docs/PLAN.md` (Milestone 7) and `docs/NEXT_SESSION.md`. M1–M7 are complete; this session handles what my Windows run found. Here are my results: <paste the failures, the times `a11y.spec.ts` printed, and the smoke checklist answers>. For each problem, find the cause, fix it with a test where one can run in the container, run `pnpm check` (and `pnpm test:e2e` for UI changes), commit and push to `main`, and log it in `docs/BUILD_LOG.md`. Say plainly what you could not verify. Do not start new features: the parked ideas in `docs/PLAN.md` ("Potential extensions") need my go-ahead first. Use Sonnet for fixes in UI, wiring and packaging, and Opus for anything in rendering determinism, crash recovery or schemas; tell me when to switch.

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
