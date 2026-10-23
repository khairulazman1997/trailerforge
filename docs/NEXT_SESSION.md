# Prompt for the next session (Milestone 3, Capture Pack)

Paste this as the first message of a fresh session.

---

Read `CLAUDE.md` and `docs/PLAN.md` (the "Milestone 3 — Capture Pack" section at the end) first. Milestones 1 and 2 are complete; M3 has a task table but four design defaults listed under it are not yet confirmed.

Do this, in order:

1. Ask me to confirm or change the four design defaults listed under the M3 heading (formats, recording-settings source, where notes live, grouping key). Do not ask anything else you can decide yourself.
2. Give a token/usage estimate for the first session of M3 (task 3.1 on Opus, or 3.1–3.4 if I say so) and tell me which model each task needs.
3. Build task 3.1 (capture plan builder) in `packages/pack-game-trailer` (pure functions, property tests for determinism and "every unrecorded shot appears exactly once"). Follow CLAUDE.md: `pnpm check` before every commit, commit and push to `main`, log start/end times with `date -u` and my usage readings in `docs/BUILD_LOG.md`, update `CLAUDE.md` Progress.
4. Stop after 3.1 and tell me which model 3.2 needs; wait for "go".

Constraints that matter: derived capture data is computed from `project.json`, never stored as a second copy; user edits go through typed commands and are undoable; anything sent to an LLM must exclude entities the user marked excluded; no network calls outside the `Egress` service. Keep turns lean (I am on Claude Pro) and prefer targeted reads over re-reading large files.

Parked idea (not planned): built-in recording/OBS control is listed under "Potential extensions" in `docs/PLAN.md`; do not build it.

Electron (`apps/desktop`) was launched successfully on the user's Windows desktop. Open desktop polish, to fold into task 3.8 or a small Sonnet task: use the preload folder/file pickers (Browse buttons on the open/new project and add-repo forms), hide the "Disconnect" button and the default File/Edit/View/Window menu in desktop mode, and show Windows-style path placeholders.
