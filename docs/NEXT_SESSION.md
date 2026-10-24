# Prompt for the next session (after Milestone 3)

Paste this as the first message of a fresh session.

---

Read `CLAUDE.md` and `docs/PLAN.md` first. Milestones 1, 2 and 3 (Capture Pack) are complete.

Do this, in order:

1. **Desktop smoke results.** I ran the checklist below on my Windows machine; I will paste what happened. Fix anything that failed (Sonnet).
2. **Desktop polish (Sonnet, small):** use the preload folder/file pickers for the Browse buttons on the open/new project and add-repo forms; hide the "Disconnect" button and the default File/Edit/View/Window menu in desktop mode; Windows-style path placeholders. `pnpm check`, `pnpm test:e2e`, commit, push, log in `docs/BUILD_LOG.md`.
3. Stop, tell me the model for the next step and wait for "go".
4. **Break down M4 (Ingest + auto-cut) on Opus:** ask me only the design questions you cannot decide yourself, then add a task table to `docs/PLAN.md` in the M3 style (model per task, acceptance criteria) and give a usage estimate. The capture pack JSON (`trailerforge.capture-pack` v1, slot ids, group keys, record lengths) is the hand-off from M3.

Constraints: derived data is computed from `project.json`, never stored twice; edits go through typed commands and are undoable; anything sent to an LLM excludes entities I marked excluded; no network calls outside the `Egress` service; never upload footage or game source. Keep turns lean (I am on Claude Pro).

## Desktop smoke checklist (run on Windows, report back)

1. `pnpm approve-builds` (allow electron), `pnpm build`, `pnpm --filter @trailerforge/desktop start`.
2. Open or create a project, generate a storyboard (Chat Handoff is fine), open the **Capture** tab.
3. Tick a shot, add a take and a note, undo once. Change the frame rate, then reset it.
4. In "Share the pack", click **Write to the project folder**; open `exports/capture/capture-pack.html` in a browser and print-preview it.
5. Click **Download Markdown**: does a Windows **Save As** dialog appear, and does the saved file open?
6. Quit the app; reopen the project; the ticks, takes and notes are still there.
