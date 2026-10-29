# Next session (Milestone 6, Review + render)

Paste the block below as the first message of a fresh session. Start on **Opus** (the breakdown and the render compiler are Opus work).

---

Read `CLAUDE.md`, then `docs/PLAN.md`: the milestone table, the Quality Gate and NLE handoff lines, the M4 note on what was left for M6 (J/L cuts, screen-direction continuity, speed ramps, the full Quality Gate pass), and the end of the M5 section (what M5 hands to M6, and its known gaps). M1–M5 are complete. M5 left M6 these pieces: derived version timelines (`deriveVariant`), graphics frames as PNG sequences with alpha (`@trailerforge/render`, `renderVariantGraphicsOp`), transitions and effects as FFmpeg filter fragments plus the flash guard (`@trailerforge/effects`), and SFX tracks with music ducks.

Do this, in order:

1. Break M6 down the way M4 and M5 were: a short scope paragraph, the design decisions I need to make, each with your recommended default (for example: export formats and presets per platform, hardware encoding, review/approval flow and comments, which Quality Gate checks block an export, NLE handoff formats (FCPXML / EDL / OTIO) and in which order, whether to re-snap shortened versions to the beat, and the open M5 gaps), then a task table (id, task, model, acceptance) in `docs/PLAN.md` under a new "Milestone 6" heading. Include a render compiler task (timeline → one deterministic FFmpeg filtergraph: picture, reframe crops and blurred fill, transitions, effects, graphics overlays, audio mix with ducks and loudness), crash-safe resumable renders as jobs, the Quality Gate, the review screens, export, NLE handoff, and hardening/docs last.
2. Ask me to confirm or change the defaults (ask nothing you can decide yourself) and record my answers under the M6 heading.
3. Give a usage estimate for the milestone and for this session, and say which model each task needs.
4. Build the first task. Stop after it, tell me which model the next one needs, and wait for "go".

Constraints:

- `project.json` is the single source of truth; derived data (version timelines, render plans, frames) is never stored twice.
- Edits go through typed, undoable commands; timeline time is integer flicks.
- Same project + same inputs = same render plan and the same output (pin what you must; say where bit-identical video is not possible, for example hardware encoders).
- Anything sent to an LLM leaves out entities I marked excluded; the LLM may only pick ids from the installed set.
- No network calls outside the Egress service; never upload footage or game source. Uploading to platforms is not M6 work unless I say so.
- Parked ideas (built-in recording/OBS, drag-to-edit on the timeline, deeper offline repo scan, automatic Unity recording) are not this milestone's work.

Workflow (this is a Windows PC):

- One task at a time: `pnpm check` (run uv outside Claude Code's sandbox), and for UI work `pnpm test:e2e` with `TFORGE_CHROMIUM` set to `C:/Program Files/Google/Chrome/Application/chrome.exe` and uv on PATH; then commit, push to `main`, update the CLAUDE.md Progress line.
- Log start and end times (`date -u`) and my usage readings in `docs/BUILD_LOG.md` under a new "Milestone 6" heading.
- At each task boundary, tell me which model the next task needs and wait for "go". Keep turns lean (Claude Pro).

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
