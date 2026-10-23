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
- `pnpm format` — Prettier
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

`tforge new|info|probe|proxy|jobs|plugins` plus `knowledge scan`, `brief check`, `storyboard generate`, `mcp`, `serve` (see README). The engine owns the LLM client (`engine.llm`, routes from `<home>/llm.routes.json`).

## Progress

- M1 complete. M2a in progress: M2a (backend) complete: 2a.1–2a.8 done. 2b.1 (storyboard hand-editing) done. Remaining M2: 2b.2–2b.10 (MCP server, service, UI, Electron) ; 2b.2 (MCP server) 2b.3 (local engine service) and 2b.4 (UI scaffold) 2b.5 (brief & intake UI) and 2b.6 (knowledge UI) done; next is 2b.7 (storyboard UI, Sonnet). M2b task list: end of `docs/PLAN.md`. Task list: end of `docs/PLAN.md`.
- Record start/end times and usage readings per task in `docs/BUILD_LOG.md` (stamp with `date -u`).
- Commit only after `pnpm check` passes: `pnpm check && git commit ...`.

## Game repo knowledge

User's game is **Unity**. Extractor priority: generic + Unity first (M2); Godot/Unreal later.
