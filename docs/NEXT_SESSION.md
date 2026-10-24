# Prompt for the next session (Milestone 4, Ingest + auto-cut)

Start a fresh session on **Opus** and paste everything below the line as the first message.

---

Read `CLAUDE.md` and `docs/PLAN.md` first: the Decisions, Core principles, "Professional editing quality", "Effects & vector graphics", "Motion engine", "Model routing" and "Build token estimates" sections, and the finished "Milestone 3 — Capture Pack" section (M4 has no task table yet). Milestones 1–3 are complete. Read code only where you need it (targeted reads; I am on Claude Pro).

Do this, in order:

1. **Ask me only the M4 design questions you cannot decide yourself** (give a recommended default for each, like the M3 defaults). Likely candidates: how recorded files are found (watch a folder, import by hand, or both), how a file is matched to a shot (capture-pack slot ids in file names, timestamps, manual, AI help), what the first auto-cut must deliver (rough cut on the music, or tighter), and how much AI the cut may use. Do not ask anything with a sensible default.
2. **Break M4 down** into a task table at the end of `docs/PLAN.md`, in the M3 style: numbered tasks, model per task (Opus for schemas, matching/cut algorithms, determinism, crash recovery; Sonnet for wiring, UI, fixtures, docs), acceptance criteria, a hardening task at the end, and suggested sessions. Build on what exists: the M1 media package (probe, proxies, background jobs), the timeline schema in flicks, the capture pack JSON (`trailerforge.capture-pack` v1: slot ids, group keys, record lengths, statuses) and the capture commands (`game-trailer/capture.set-status` etc.).
3. **Give a usage estimate** for the whole of M4 and per session (the plan's rough figure is 230–345k output tokens; M3 used about 45–50% of one session window and 5% of the week for ~80–120k planned).
4. `pnpm check`, commit and push the plan to `main`, update the `CLAUDE.md` Progress line, and log the start/end time (`date -u`) and my usage readings in `docs/BUILD_LOG.md` under a new "Milestone 4" heading.
5. **Stop.** Tell me which model task 4.1 needs and wait for "go".

Constraints that matter: `project.json` is the single source of truth and derived data is never stored twice; edits go through typed, undoable commands; timeline time is integer flicks; anything sent to an LLM excludes entities I marked excluded; no network calls outside the `Egress` service; **never upload footage or game source**. Built-in recording/OBS control is a parked idea, not M4.

Deferred (no Windows machine right now): the desktop smoke checklist and desktop polish below. Do not start them unless I ask; keep them on the list.

## Deferred: desktop smoke checklist (run on Windows later)

1. `pnpm approve-builds` (allow electron), `pnpm build`, `pnpm --filter @trailerforge/desktop start`.
2. Open or create a project, generate a storyboard (Chat Handoff is fine), open the **Capture** tab.
3. Tick a shot, add a take and a note, undo once. Change the frame rate, then reset it.
4. In "Share the pack", click **Write to the project folder**; open `exports/capture/capture-pack.html` in a browser and print-preview it.
5. Click **Download Markdown**: does a Windows **Save As** dialog appear, and does the saved file open?
6. Quit the app; reopen the project; the ticks, takes and notes are still there.

## Deferred: desktop polish (Sonnet, small)

Use the preload folder/file pickers for the Browse buttons (open/new project, add repo); hide the "Disconnect" button and the default File/Edit/View/Window menu in desktop mode; Windows-style path placeholders.
