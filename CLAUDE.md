# TrailerForge — working notes for Claude

Read `docs/PLAN.md` first: it holds every approved decision, the milestone plan and task breakdown.

## Workflow

- Build milestone by milestone; finish one task, run `pnpm check`, commit, push to `main`, then report.
- **Model switching is manual.** Opus for schemas, interfaces, algorithms, determinism, crash recovery, hard debugging; Sonnet for scaffolding, UI, wiring, fixtures, docs. At each task boundary, tell the user which model the next task needs and wait for "go".
- Give a token/usage estimate before each milestone starts; the user reports Claude Pro usage % at checkpoints.
- The user is on Claude Pro: keep turns lean, avoid re-reading large files, prefer targeted reads.

## Commands

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

## Packages (M1)

schema · core (store, commands, events) · jobs · plugin-api · media · llm · engine (+ core plugin) · apps/cli. Anthropic API provider and the UI/MCP server arrive in M2.

## Game repo knowledge

User's game is **Unity**. Extractor priority: generic + Unity first (M2); Godot/Unreal later.
