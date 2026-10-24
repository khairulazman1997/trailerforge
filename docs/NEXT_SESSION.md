# Next session (Milestone 5, Variants + graphics)

Paste the block below as the first message of a fresh session. Start on **Opus**.

---

Read `CLAUDE.md`, then the "Milestone 5 — Variants + graphics" section of `docs/PLAN.md` (task table 5.1–5.13 and the six design defaults above it). M1–M4 are complete, including 4.12b, captions on the rough cut, the Claude Code connection and the Windows fixes.

Do this, in order:

1. Ask me to confirm or change the six M5 design defaults (which variants by default, reframing, brand kit, skipping the EffectCraft spike, sound effects, effect suggestions in generation). Ask nothing else you can decide yourself. Record my answers under the M5 heading.
2. Give a usage estimate for this session (task 5.1, or 5.1–5.2 if I say so) and say which model each task needs.
3. Build task 5.1 (variant model and derivation) as described in PLAN: pure functions, property tests, no derived timeline stored in `project.json`.
4. Stop after the task, tell me which model the next one needs, and wait for "go".

Constraints:

- `project.json` is the single source of truth; derived data is never stored twice.
- Edits go through typed, undoable commands; timeline time is integer flicks.
- Anything sent to an LLM leaves out entities I marked excluded; the LLM may only pick effect and template ids from the installed set.
- No network calls outside the Egress service; never upload footage or game source.
- Parked ideas (built-in recording/OBS, drag-to-edit on the timeline, deeper offline repo scan, automatic Unity recording) are not this milestone's work.

Workflow (this is a Windows PC):

- One task at a time: `pnpm check` (run uv outside Claude Code's sandbox), and for UI work `pnpm test:e2e` with `TFORGE_CHROMIUM` set to `C:/Program Files/Google/Chrome/Application/chrome.exe` and uv on PATH; then commit, push to `main`, update the CLAUDE.md Progress line.
- Log start and end times (`date -u`) and my usage readings in `docs/BUILD_LOG.md` under "Milestone 5".
- At each task boundary, tell me which model the next task needs and wait for "go". Keep turns lean (Claude Pro).

---

## Human review of a rough cut (the user, on a real machine)

The plan asks for a person to judge an M4 cut. With your own recordings and a music track: Footage tab → add the folder → attach → Cut tab → choose the music → Analyse → Build the cut → Play. Note what feels wrong (cuts that miss the beat, a dull stretch of a take, a shot too long or short) and send it back; the numbers the tests track are in `packages/cut/src/__snapshots__/metrics.test.ts.snap`. Also check on Windows: drag and drop onto the Footage tab, Choose folder…, and that the preview shows picture (headless test browsers cannot decode H.264).

## Deferred: desktop smoke checklist (run on Windows later)

1. `pnpm approve-builds` (allow electron), `pnpm build`, `pnpm --filter @trailerforge/desktop start`.
2. Open or create a project, generate a storyboard (Chat Handoff is fine), open the **Capture** tab.
3. Tick a shot, add a take and a note, undo once. Change the frame rate, then reset it.
4. In "Share the pack", click **Write to the project folder**; open `exports/capture/capture-pack.html` in a browser and print-preview it.
5. Click **Download Markdown**: does a Windows **Save As** dialog appear, and does the saved file open?
6. Quit the app; reopen the project; the ticks, takes and notes are still there.

## Deferred: desktop polish (Sonnet, small)

Browse buttons with the native pickers are done (2026-10-25). Still open: hide the "Disconnect" button and the default File/Edit/View/Window menu in desktop mode; Windows-style path placeholders.
