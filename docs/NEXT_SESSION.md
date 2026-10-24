# Next session

M4 (Ingest + auto-cut) is complete apart from the items below. Start on **Opus**.

1. **Live vision download test** (needs `us.aws.cdn.hf.co` reachable; a new session after adding `hf.co` to the allowed domains): `cd packages/analysis && TFORGE_VISION_LIVE=1 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npx vitest run src/vision.test.ts -t live`.
2. **4.12b** (see the end of the M4 section in `docs/PLAN.md`): vision wiring and opt-in dialog, watched-folder setting, previews on screen, takes in the Capture tab.
3. Then break down **M5** (variants + graphics) the same way as M4.

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

Use the preload folder/file pickers for the Browse buttons (open/new project, add repo); hide the "Disconnect" button and the default File/Edit/View/Window menu in desktop mode; Windows-style path placeholders.
