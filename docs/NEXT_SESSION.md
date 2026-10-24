# Next session (Milestone 4, Ingest + auto-cut)

M4 is broken down (task table 4.1–4.14 at the end of `docs/PLAN.md`). Start on **Opus** with task 4.1 (ingest schemas and asset library), then 4.2, following the suggested sessions in the plan.

The desktop items below are deferred until the user has their Windows machine; keep them on the list and do not start them unless asked.

## Deferred: desktop smoke checklist (run on Windows later)

1. `pnpm approve-builds` (allow electron), `pnpm build`, `pnpm --filter @trailerforge/desktop start`.
2. Open or create a project, generate a storyboard (Chat Handoff is fine), open the **Capture** tab.
3. Tick a shot, add a take and a note, undo once. Change the frame rate, then reset it.
4. In "Share the pack", click **Write to the project folder**; open `exports/capture/capture-pack.html` in a browser and print-preview it.
5. Click **Download Markdown**: does a Windows **Save As** dialog appear, and does the saved file open?
6. Quit the app; reopen the project; the ticks, takes and notes are still there.

## Deferred: desktop polish (Sonnet, small)

Use the preload folder/file pickers for the Browse buttons (open/new project, add repo); hide the "Disconnect" button and the default File/Edit/View/Window menu in desktop mode; Windows-style path placeholders.
