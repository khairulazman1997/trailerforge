# TrailerForge — working notes for Claude

Read `docs/PLAN.md` first: it holds every approved decision, the milestone plan and task breakdown.

## Workflow

- Build milestone by milestone; finish one task, run `pnpm check`, commit, push to `main`, then report.
- **Model switching is manual.** Opus for schemas, interfaces, algorithms, determinism, crash recovery, hard debugging; Sonnet for scaffolding, UI, wiring, fixtures, docs. At each task boundary, tell the user which model the next task needs and wait for "go".
- Give a token/usage estimate before each milestone starts; the user reports Claude Pro usage % at checkpoints.
- The user is on Claude Pro: keep turns lean, avoid re-reading large files, prefer targeted reads.

## Commands

- `pnpm test:e2e` — builds, then Playwright browser tests for the UI (not part of `pnpm check`; needs Chromium, set `TFORGE_CHROMIUM` if Playwright's download is absent). Run it before committing UI work.
- `pnpm check` — typecheck, lint, format check, TS tests, Python tests (must pass before every commit)
- `pnpm build` — builds packages; `@trailerforge/schema` also writes `dist/schemas/*.schema.json`
- `pnpm format` — Prettier (run it from the repo root: the ignore file for golden files lives there)
- Python sidecar: `cd workers/analysis && uv run pytest` / `uv run ruff check .`

## Conventions

- TypeScript strict (pinned to 6.x until typescript-eslint supports 7), ESM, `.js` import suffixes.
- Zod 4 `z.strictObject` everywhere; plugin data goes under `extensions[packId]`, never new ad-hoc keys.
- Timeline time = integer flicks (`@trailerforge/schema` `time.ts`); storyboard durations = seconds.
- `project.json` is the single source of truth; mutate only through typed commands (task 1.4).
- `parseProject()` (schema + cross-reference checks) gates every project load.
- Tests sit next to sources as `*.test.ts`; reuse `@trailerforge/schema/fixtures` `sampleProject()`.
- Local-first: no network calls outside the `Egress` service; never upload footage or game source.

## Packages

schema · core (store, commands, events) · jobs · plugin-api · media · llm · engine (+ core plugin) · apps/cli. Added in M2a: pack-game-trailer (Game Trailer plugin: video types, brief extension, storyboard templates, `game-trailer/unity` extractor) · brief (completeness checker, questionnaire, brief commands, "suggest for me") · storyboard (LLM generation, regenerate-one-section that keeps hand-edited slots, lock-enforcing storyboard commands, hand-edit commands `core/storyboard.update-slot|add-slot|remove-slot|move-slot|add-section|...`). knowledge (read-only repo scanner with secret exclusion and incremental hashing, `core/generic` extractor, knowledge merge commands that preserve user edits, opt-in deep scan via Claude Code in a sandbox copy). Decision log: `appendDecisions`/`readDecisions` in core. Anthropic provider (`core/anthropic`, needs ANTHROPIC_API_KEY; live test: `ANTHROPIC_LIVE=1`) done; mcp (MCP server: read/action/command tools, `tforge mcp`); engine `ops` (brief form/answer/suggest/assume, generate/regenerate storyboard, knowledge scan; cancellable) shared by CLI, MCP and service. service (`tforge serve`: loopback HTTP API + SSE event stream, token/Host/Origin checks, tasks; browser-safe `@trailerforge/service/client`). ui (`apps/ui`: Vite + React; framework-free `AppStore` mirrors engine state from the event stream; selectors must return stable values; `pnpm test:e2e` runs Playwright against the real service).

## CLI

`tforge new|info|probe|proxy|jobs|plugins` plus `knowledge scan`, `brief check`, `storyboard generate`, `capture plan|status|settings|mark|tips|export`, `mcp`, `serve` (see README). The engine owns the LLM client (`engine.llm`, routes from `<home>/llm.routes.json`).

## Progress

- M1, M2 (2a + 2b) and M3 Capture Pack complete (M3: 3.1–3.9 plus 3.4b, end of `docs/PLAN.md`; README has the capture guide). M3 notes: 3.1 capture plan builder done (`buildCapturePlan` in pack-game-trailer `capture.ts`; capture state on `slot.extensions['game-trailer'].capture`); 3.2 recording settings done (`resolveRecordingSettings`, overrides at `project.extensions['game-trailer'].recording`, commands `game-trailer/recording.set-overrides|reset-overrides`); 3.3 capture commands done (`game-trailer/capture.set-status|set-notes|set-takes|set-skipped|reorder-group`); 3.4 setup hints done (`buildCaptureHints`, `forLlm` drops excluded entities; entities tagged `debug-command` / `save-file` / `all-levels`); 3.5 capture tips done (`generateCaptureTips` returns a payload for `game-trailer/capture.apply-tips|edit-tips|clear-tips`; stored at `extensions['game-trailer'].captureTips`; excluded knowledge redacted from the prompt); 3.4b done (Unity extractor reads C# for console commands and save locations, tagged so hints pick them up; `ExtractedEntity.tags` merged by union); 3.6 pack export done (`buildCapturePack`, `renderCapturePack(md|html|json)`, `writeCapturePack` → `<project>/exports/capture/`; golden files in `src/__golden__`, regenerate with `UPDATE_GOLDEN=1`); 3.7 engine ops/service/CLI/MCP done (`captureViewOp|StatusOp|SettingsOp|MarkOp|TipsOp|ExportOp`; service `GET …/capture`, `…/capture/status`, `POST …/capture/export`, task kind `capture-tips`, preview task `capture.tips`; `tforge capture plan|status|settings|mark|tips|export`; MCP `capture_*` tools); 3.8a Capture tab done (`apps/ui` `pages/Capture.tsx`; the UI computes the plan itself from project state with `@trailerforge/pack-game-trailer/browser`, which must stay free of Node imports; controls use `usePending` so a chosen value does not snap back); 3.8b tips (`CaptureTipsBlock`, `CaptureTipsDialog`) and export (`ExportPanel`: write to `exports/capture/`, or download via `POST …/capture/render`; the desktop app's save dialog is Electron's default for downloads, not yet confirmed on the desktop) done; 3.9 hardening done (exclusion guards check only user text, so short names like "Key" or "Off" work; axe runs in `e2e/capture-flow.spec.ts`; use `--warn-text`/`--ok-text` for coloured text). Next: break down and build M4 Ingest + auto-cut (Opus first; starter prompt in `docs/NEXT_SESSION.md`). Desktop smoke and polish are deferred until the user has their Windows machine (checklist in the same file). Electron app launched on the user's Windows desktop (2026-10-23): window opens, service connects, Projects and Settings render. Desktop polish still open: Browse buttons using the preload pickers, hide the "Disconnect" button and default File/Edit/View menu in desktop mode, Windows-style path placeholders.
- Record start/end times and usage readings per task in `docs/BUILD_LOG.md` (stamp with `date -u`).
- Commit only after `pnpm check` passes: `pnpm check && git commit ...`.

## Game repo knowledge

User's game is **Unity**. Extractor priority: generic + Unity first (M2); Godot/Unreal later.
