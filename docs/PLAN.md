# TrailerForge — Architecture Plan

Status: **approved 2026-10-23**. Model approach: **manual switching** (Opus only where needed, Sonnet otherwise). Motion engine: **option A** (EffectCraft optional plugin, M5b, after spike).

## Decisions

| #   | Topic            | Decision                                                                                                                                                                                                                  |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shell            | Electron + React + TypeScript (Win/macOS/Linux). Engine runs as a local Node service, so the UI also runs in a browser ("web mode") for headless dev/testing.                                                             |
| 2   | LLM              | Provider-agnostic adapter: Anthropic (default), OpenAI, Ollama, deterministic Mock, and **Chat Handoff** (copy a self-contained prompt into a chat, paste the JSON reply back; validated + "fix these errors" follow-up). |
| 3   | Paid APIs        | LLM only. All analysis local (faster-whisper, PySceneDetect, librosa, OpenCV).                                                                                                                                            |
| 4   | Hardware         | CPU baseline; NVENC / VideoToolbox / QSV / VAAPI used when detected.                                                                                                                                                      |
| 5   | Licensing        | Closed-source-compatible: system/user-installed FFmpeg detected at runtime; avoid Essentia (AGPL) and Remotion (company license); graphics via `@napi-rs/canvas`.                                                         |
| 6   | Reference videos | Local upload primary; URL download via user-installed `yt-dlp`, explicit opt-in. Structure only.                                                                                                                          |
| 7   | Demo assets      | Procedurally generated synthetic footage + music (known ground truth for tests).                                                                                                                                          |
| 8   | Repo             | pnpm + Turborepo monorepo in this repository.                                                                                                                                                                             |

## Repo layout

```
packages/
  schema/      Zod schemas (Project, Brief, Storyboard, Timeline, Assets, Capture, Review, Campaign fields), JSON Schema export, migrations
  core/        Domain services, ProjectStore, command bus + undo/redo, event bus
  jobs/        Persistent SQLite job queue (progress, cancel, resume, retry)
  media/       ffprobe/ffmpeg wrapper, capability detection, filtergraph builder, render compiler, Quality Gate measurements
  graphics/    Text cards, lower-thirds, laurels, end slates, captions
  llm/         Providers (incl. chat-handoff), structured output + repair, prompts/*.md, llm.routes.json
  plugin-api/  Public versioned plugin interface + registries
  plugins/     Built-in video types, templates, platform profiles, transitions, export presets
workers/analysis/  Python sidecar (JSON-RPC over stdio)
apps/ engine/ ui/ desktop/ cli/
```

## Core principles

1. **project.json is the single source of truth.** Project = folder `X.tforge/` with `project.json`, `history/`, `media/` (hash-referenced), `cache/` (regenerable), `logs/decisions.jsonl`. SQLite is index/cache/jobs only.
2. **All mutations are typed commands** (Immer patches) → undo/redo, autosave, history, events.
3. **Master storyboard + derived variants** (derivation rules + sparse overrides).
4. **Deterministic render:** `compile(project, variantId) → RenderGraph` (pure, hashable) → ffmpeg. Segmented, checkpointed, resumable.
5. **Every AI decision carries a reason object**, shown in UI and logged.
6. **Plugins** via `definePlugin({ id, apiVersion, register(ctx) })`; built-ins use the same API.
7. **Local-first:** all network calls go through a single disclosed, logged `Egress` service.

## Professional editing quality

- **Edit-grammar engine** (deterministic, explainable): cut on action, cut 1–2 frames ahead of the beat, no jump cuts, screen-direction continuity, accelerating pacing curve, holds after big moments, music edits only on bar/phrase boundaries, J/L cuts, no flash frames, no cutting mid-ease. Targets per video type come from measured reference trailers.
- **Audio:** platform LUFS targets, true peak ≤ -1 dBTP, LRA control, sidechain ducking, VO chain (HPF, de-ess, compression), 48 kHz.
- **Picture:** correct BT.709 tags/range, 10-bit internal, Lanczos scaling, judder-free fps choice, optical-flow speed ramps, per-shot exposure/white-balance match.
- **Typography/motion:** type scale, safe areas, eased animation, brand tokens, contrast checks.
- **Quality Gate** (pre-export pass/fail): loudness/peak, clipping, sync drift, black/flash frames, jump cuts, text read time, safe areas, **photosensitive flash risk**, pacing curve.
- **NLE handoff:** FCPXML / EDL / OpenTimelineIO export (M6).
- **Evaluation loop:** fixed brief corpus re-rendered on every cut-logic change, with metric regressions; human review of M4/M6 cuts.

## Effects & vector graphics

- **Vectors:** SVG templates rendered via resvg (MPL-2.0): title/tagline cards, end slates, laurels, lower-thirds, CTAs, caption boxes, icons. Brand tokens drive colors, fonts, logo.
- **Animation:** keyframe system with easing curves (position, scale, opacity, mask reveals, stroke draw-on, per-letter/per-word text).
- **Transitions:** cut, dip, flash, whip (motion blur), zoom punch, glitch, speed ramp, plus FFmpeg `xfade` set.
- **Finishing FX:** grain, vignette, chromatic aberration, impact shake, procedural light leaks/flares, letterbox, highlight glow. Subtle defaults.
- **SFX:** procedural whoosh/riser/impact/sub-drop; first-class support for licensed/CC0 SFX packs placed on hit-points.
- **Not in scope:** illustration/key art, recreated platform or rating logos (use official brand-kit files), generative imagery.
- **Architecture:** each template/effect is a plugin (param schema + renderer + preview); effects are filtergraph fragments inside the deterministic render path; graphics render to alpha frame sequences composited by FFmpeg. Optional Lottie import in M7.

## Motion engine (approved: option A)

- M1 defines a `MotionRenderer` plugin interface; built-in canvas + FFmpeg renderer is the default.
- **EffectCraft** (storytold/effectcraft, MIT/Apache-2.0, alpha) as an optional adapter plugin: generate `.ecproj`, render headless via `effectcraft-cli render`, composite ProRes 4444 alpha with FFmpeg. Pinned version, contract tests, fallback to built-in renderer. Lottie as stable interchange. "Open in EffectCraft" for hero-shot polish.
- 1–2 day spike before M5 (headless Linux, alpha output, determinism, speed) decides go/no-go.
- After Effects `.jsx` export kept as a separate handoff option.

## Game repo knowledge (local)

Point a project at a local game repository; TrailerForge extracts a **Game Knowledge digest** that feeds brief auto-fill, storyboard generation and the capture pack (real level, boss, ability and item names; scene-based capture grouping; setup hints such as debug commands or save files).

- **Read-only and local:** never writes to the game repo; respects `.gitignore`, user include/exclude globs, size caps; skips binaries and LFS pointers; secret files (`.env`, keys, credentials) are always excluded. Incremental re-scan by file hash.
- **What leaves the machine:** only the digest (names + short descriptions), never source code. The digest is shown in a review panel with per-entry toggles before any LLM call; Chat Handoff and Ollama keep it fully local.
- **Extractor plugins** (`KnowledgeExtractor` interface; **priority: generic + Unity**, the user's engine): generic (README, design docs, localization CSV/PO/JSON, achievements, store text), Unity (product name, build scenes, ScriptableObjects, prefab names), Godot (`project.godot`, `.tscn`, `.tres`), Unreal (`.uproject`, `DefaultGame.ini`, map/asset names from paths, exported DataTables).
- **Git-aware (optional):** "what changed since tag X" for update/DLC and feature-spotlight trailers.
- **Schema:** `project.sources[]` (path, extractor, globs, last scan, digest hash); digest entities (level, character, enemy, boss, ability, item, mechanic, quest, cutscene, achievement, music, art) with source paths and confidence; storyboard slots can reference entity ids. Digest cache lives in `cache/`; user edits to entities are saved in the project.
- **Milestones:** schema + extractor interface in M1 (with 1.3/1.7); extractors, digest review UI and brief auto-fill in M2.

## Claude Code integration

1. **Claude Code LLM provider** — `providers/claude-code` calls the locally installed `claude` CLI headlessly, using the user's own Claude Code login (no API key, no per-call billing). Output is validated against the same schemas as every provider. Default route when Claude Code is installed and no API key is set. Intended for the user's own local use; distribution would require each user's own install or an API key (check Anthropic terms before shipping). Interface in 1.9, implementation in M2.
2. **TrailerForge MCP server** — exposes typed commands as MCP tools (project/brief/storyboard read and edit, section regenerate, auto-cut, Quality Gate report, render) so Claude Code can drive projects. All edits go through the command bus, so they are validated, undoable and in version history. Core tools in M2, extended in M4–M6.
3. **Deep repo scan via Claude Code (opt-in)** — Claude Code explores the game repo (ScriptableObjects, scripts) to build a richer knowledge digest: mechanics, boss phases, debug commands for capture setup. Sends repo contents to Anthropic, so it is off by default with an explicit warning; results go through the same digest review panel. M2.

Estimated cost: ~50–80k extra output tokens (~+3–5% overall).

## General video editing extensibility (design for, don't build)

- Core is domain-neutral; game-trailer specifics (video types, HUD detection, gameplay labeling, platform badges, capture tips) live in a **Game Trailer domain pack** plugin.
- Timeline schema is a general multi-track model (video/audio/graphics tracks, nested sequences, keyframes on any property); storyboard slots are a layer on top of it, not the timeline itself.
- Media layer handles camera/phone footage: rotation metadata, VFR, HDR/log, mixed fps, multi-channel audio, audio-based multicam sync (later).
- Future "General Editing pack": full NLE tools (ripple/roll/slip/slide, multicam, color, audio mixer).

## Content Calendar Planner readiness

`campaignId`, `scheduledDate`, `platformTargets[]`, `status` on every project from M1; shared tagged asset library with `reuseHistory`; `nav.planner` UI slot behind `features.planner`; stable `core.projects.createFromCalendarSlot(slot)` API.

## Model routing

### Building (Claude Code)

Opus for schemas, interfaces, algorithms, determinism, crash recovery, hard debugging. Sonnet for UI, wiring, fixtures, docs, template content.

| Milestone              | Lead          |
| ---------------------- | ------------- |
| M1 Foundations         | Opus (~70%)   |
| M2 Intake + storyboard | Mixed         |
| M3 Capture Pack        | Sonnet (~80%) |
| M4 Ingest + auto-cut   | Opus (~75%)   |
| M5 Variants + graphics | Mixed         |
| M6 Review + render     | Mixed         |
| M7 Polish              | Sonnet (~65%) |
| M8 Planner scaffold    | Sonnet (~85%) |

### In-app defaults (`llm.routes.json`, user-editable)

| Task                  | Model / effort                            |
| --------------------- | ----------------------------------------- |
| Brief parsing         | Haiku 5.5 / low                           |
| Completeness scoring  | No LLM (rules)                            |
| "Suggest for me"      | Sonnet 5.5 / low                          |
| Full storyboard       | Opus 5.5 / high                           |
| Section regenerate    | Sonnet 5.5 / medium                       |
| VO script             | Opus 5.5 / medium                         |
| Capture Pack          | Deterministic + Sonnet 5.5 / low for tips |
| Reference → template  | Sonnet 5.5 / medium                       |
| AI critique           | Opus 5.5 / high                           |
| Decision explanations | No LLM                                    |

## Build token estimates (rough; refined before each milestone)

| Milestone | Output tokens | Total processed |
| --------- | ------------- | --------------- |
| M1        | 135–195k      | 11–19M          |
| M2        | 180–260k      | 15–25M          |
| M3        | 80–120k       | 6–10M           |
| M4        | 230–345k      | 23–40M          |
| M5        | 170–255k      | 17–29M          |
| M6        | 230–320k      | 21–35M          |
| M7        | 120–200k      | 12–20M          |
| M8        | 50–80k        | 4–8M            |

Plan: pause after M1 tasks 1.1–1.2 to read actual plan usage % and extrapolate.

## Milestone 1 — Foundations ✅ complete (2026-10-23)

| #    | Task                                                                                                                                                    | Acceptance                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1.1  | Monorepo scaffold, TS strict, lint, Vitest, CI; Python sidecar (uv, pytest)                                                                             | Clean `pnpm build && pnpm test`; sidecar `ping`                     |
| 1.2  | `schema` package (all core schemas + campaign fields)                                                                                                   | Round-trip/validation tests; JSON Schema export                     |
| 1.3  | Versioning + migrations                                                                                                                                 | v0→v1 sample migration with backup                                  |
| 1.4  | ProjectStore: atomic save, autosave, JSON-patch history, command bus, undo/redo                                                                         | Crash-safety + undo/redo tests                                      |
| 1.5  | Typed event bus                                                                                                                                         | Subscribe/unsubscribe/error-isolation tests                         |
| 1.6  | Persistent job queue                                                                                                                                    | Survives restart, resumes from checkpoint, cancel cleans temp       |
| 1.7  | Plugin API + loader                                                                                                                                     | Sample plugin registers video type + preset; broken plugin isolated |
| 1.8  | `media` wrapper: probe, capabilities/hwaccel, proxies/thumbs, filtergraph builder, typed errors, **loudness/peak measurement + Quality Gate framework** | Tests on generated fixtures; every error path tested                |
| 1.9  | `llm` adapter: providers incl. Mock + **Chat Handoff**, prompt loader, validate/repair, `llm.routes.json`                                               | Contract tests with Mock and Handoff                                |
| 1.10 | Engine + CLI (`new/open/probe/jobs`)                                                                                                                    | Smoke e2e: create → save → reload → probe                           |
| 1.11 | README v0                                                                                                                                               | Setup, Mermaid architecture diagram, plugin stub guide              |

## Milestone 2a — backend: brief, templates, storyboard generation, knowledge

Estimate: ~150–230k output tokens; ~25–40% of a 5-hour window, ~3–4% of a week (calibrated on M1).

| #    | Task                                                                                                                                                                                                                                     | Model  | Acceptance                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| 2a.1 | Game Trailer pack: brief extension schema (genre, game platforms, release window, rating, Steam app id) and video types (release, announcement, gameplay) with requirements                                                              | Opus   | Pack loads through the plugin host; requirements validate                    |
| 2a.2 | `@trailerforge/brief`: completeness checker (path rules incl. `keyDates[label=Release].date`, alternatives, placeholders like "TBD"), questionnaire generation with "suggest for me", answers and "proceed with assumptions" as commands | Opus   | Unit tests for scoring, questions, answer application and logged assumptions |
| 2a.3 | Built-in storyboard templates for the three video types                                                                                                                                                                                  | Sonnet | Templates build valid storyboards at 30/60/90 s                              |
| 2a.4 | Storyboard generation: LLM output schema, prompt files, conversion to storyboard, regenerate-one-section honouring locks, decision log entries                                                                                           | Opus   | Mock-provider tests; locked sections untouched                               |
| 2a.5 | Anthropic API provider (official SDK, structured output, refusal handling)                                                                                                                                                               | Sonnet | Contract tests with a stubbed client; real call behind env flag              |
| 2a.6 | Repo scanner: .gitignore, globs, size caps, binary/LFS skip, secret exclusion, read-only, incremental hashing; generic extractor (README, docs, localization, achievements)                                                              | Opus   | Fixture repo tests incl. secrets never read                                  |
| 2a.7 | Unity extractor (ProjectSettings productName, build scenes, ScriptableObject/prefab names)                                                                                                                                               | Sonnet | Fixture Unity repo test                                                      |
| 2a.8 | Knowledge merge commands (preserve user edits), opt-in Claude Code deep scan, CLI: `brief check`, `storyboard generate`, `knowledge scan`                                                                                                | Sonnet | E2E: scan fixture repo → brief check → generate storyboard with mock         |

## Milestone 2b — editing, UI and MCP ✅ complete (2026-10-23)

Estimate (rough, ±50%): ~12–16% of a week across 3–4 five-hour windows. M2a plus 2b.1 cost about 6% of a week against a 3–4% estimate, so this is scaled up accordingly. Suggested order is the table order: the MCP server comes first because it is cheap and makes the backend usable from Claude Code immediately; Electron comes last because it is the one part that cannot be verified in this environment.

| #     | Task                                                                                                                                                                                                                                                                                                                                                                                                                                           | Model         | Acceptance                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2b.1  | Hand-editing the storyboard (added at user request): typed, undoable commands to edit/add/delete/move slots and sections, VO lines, music plan and target length; locked sections refuse edits; edited slots are remembered so regenerating a section keeps them                                                                                                                                                                               | Sonnet        | Done                                                                                                                                               |
| 2b.2  | **MCP server** (`@trailerforge/mcp`, stdio, official SDK): read tools (project summary, brief + completeness, knowledge, storyboard + timing, decision log), one tool per registered command (schema from its Zod payload, so every edit is validated and undoable), and action tools (knowledge scan, generate storyboard, regenerate section). Lets Claude Code drive a project before any UI exists                                         | Sonnet (done) | In-memory MCP client↔server test: list tools; edit a slot through a tool and undo it; invalid input comes back as a tool error and changes nothing |
| 2b.3  | **Local engine service**: HTTP + WebSocket API over the engine (queries, command dispatch, job/event stream, open/close project), bound to 127.0.0.1 with a per-launch token and origin check; typed client library shared by UI and tests                                                                                                                                                                                                     | Opus          | Contract tests incl. rejected tokens/origins, event ordering, project lock handling, cancellation                                                  |
| 2b.4  | **UI scaffold** (`apps/ui`: Vite + React + TS): app shell and routing, service client + state store (commands, undo/redo, live events), theme, error/consent dialog primitives; runs in a browser ("web mode")                                                                                                                                                                                                                                 | Sonnet        | Playwright smoke in web mode: open a project, see live state, undo/redo                                                                            |
| 2b.5  | **Brief & intake UI**: new/open project, video type, questionnaire wizard with completeness meter, "suggest for me" (accept/edit), "proceed with assumptions" with the logged assumptions visible, format targets                                                                                                                                                                                                                              | Sonnet        | Playwright: complete a brief with the mock provider; assumptions listed and removable                                                              |
| 2b.6  | **Knowledge UI**: sources, scan with progress, digest review panel (per-entry exclude-from-AI toggles, edit/add/remove, stale and deep-scan badges), deep-scan warning and explicit confirmation                                                                                                                                                                                                                                               | Sonnet        | Playwright: scan fixture repo, exclude an entry, confirm it is absent from the next prompt                                                         |
| 2b.7  | **Storyboard UI**: sections and slots, inline edit, add/delete/drag-move, lock toggle, timing bar vs target, undo/redo, "why" panel from the decision log                                                                                                                                                                                                                                                                                      | Sonnet        | Playwright: edit, reorder, delete and undo; locked sections refuse edits                                                                           |
| 2b.8  | **Generate / regenerate flows**: generate dialog (template, length, brief gating with explicit assumptions, what will be sent to which provider, once-per-session consent when data leaves the computer), rewrite-section dialog with instruction and keep-my-edits toggle, cancellable, results announced                                                                                                                                     | Sonnet (done) | Playwright with mock provider: disclosure matches the prompt, excluded facts absent, consent gate, hand-edited slots kept                          |
| 2b.9  | **Settings** (split out of 2b.8 to fit a usage window): provider status, API key entry via a `SecretStore` (file with owner-only permissions by default, OS-protected in Electron), routes editor for `llm.routes.json` with live reload (the client currently caches provider availability for good, so it must be refreshed when a key is set), Chat Handoff relay (copy the prompt, paste the reply, validation feedback, fix-it follow-up) | Sonnet (done) | Playwright: set a key and see the provider become available; edit a route and see it used; Chat Handoff round-trip including a fix-it follow-up    |
| 2b.10 | **Electron shell**: main process starts the service, preload, native folder/file dialogs, safe key storage, packaging config                                                                                                                                                                                                                                                                                                                   | Sonnet (done) | Main-process wiring tests; launch smoke run on a desktop machine (cannot be verified in the cloud container)                                       |
| 2b.11 | **M2 hardening**: end-to-end flow (create → scan → brief → generate → edit → regenerate → undo), security review of the service and key handling, docs, README update                                                                                                                                                                                                                                                                          | Opus (done)   | Playwright E2E green; review findings fixed                                                                                                        |

## Milestone 3 — Capture Pack

Turns an approved storyboard into everything needed to **record the footage**: a checklist grouped by where and how to record, recording settings, per-shot tips, and a printable/shareable pack. Footage ingest and matching are M4; here the user only marks shots as recorded by hand. Principles: deterministic first (grouping, ordering, durations, settings), LLM only for optional tips; local-only; derived data is never stored as a second source of truth (the pack is computed from `project.json`, only user edits such as status and notes are stored through commands); lives in the Game Trailer pack and `engine`, shown in `apps/ui`.

Design decisions (all four defaults confirmed by the user 2026-10-24): pack formats [Markdown + printable HTML; PDF only via browser print], recording-settings source [brief platforms + a small table in the pack, editable], whether capture notes live on the slot [yes, `extensions['game-trailer'].capture`], grouping key [`location`, then `setup`, then entity].

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                    | Model  | Acceptance                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | **Capture plan builder** (pure, deterministic): shot slots → ordered capture groups by location, then setup, then featured entity; stable order; each item carries instruction, framing, HUD, target and padded durations ("record N s so the cut has handles"), alternates, entity names; skipped slots excluded (locked sections stay in: a lock guards storyboard content, not recording) — **done** | Opus   | Property tests: every unrecorded shot appears exactly once; same input → identical output; padding rules; empty and huge cases |
| 3.2 | **Recording settings**: resolution, fps, bitrate, codec/container, HUD on/off and HDR advice derived from brief platforms and video type; per-project overrides stored with a command; warns about VFR/capture-tool pitfalls                                                                                                                                                                            | Sonnet | Table-driven tests per platform; override persists and undoes                                                                  |
| 3.3 | **Capture commands**: mark recorded/rejected/approved, add per-shot capture notes and "take" counter, reorder within a group without changing the storyboard; all through typed commands, undoable — **done** (`capture-commands.ts`)                                                                                                                                                                   | Sonnet | Command tests incl. undo; storyboard timing unchanged by capture edits                                                         |
| 3.4 | **Setup hints from game knowledge**: for each group, pull debug commands, save files, level and boss names from knowledge entities (Unity extractor data); user-edited entries win; excluded entities never appear in anything sent to an LLM                                                                                                                                                           | Sonnet | Fixture project: hints appear, exclusions respected, edits preserved after re-scan                                             |
| 3.5 | **Capture tips (LLM, optional)**: per-group tips and risk notes via the `capture.tips` route (Sonnet, low), disclosure and consent as elsewhere, results cached and editable, works with Mock and Chat Handoff                                                                                                                                                                                          | Sonnet | Mock-provider tests; prompt contains no excluded facts; tips are discarded cleanly on cancel                                   |
| 3.6 | **Pack export**: Markdown and self-contained printable HTML (checklist boxes, QR-free, no network), JSON for the future ingest step; deterministic output, written under the project's `exports/` folder                                                                                                                                                                                                | Sonnet | Golden-file tests; HTML opens offline; no absolute paths or secrets in output                                                  |
| 3.7 | **Engine ops, service routes, CLI and MCP**: `capture plan/settings/status/export` available everywhere, with the usual cancellation and `OpError` codes                                                                                                                                                                                                                                                | Sonnet | CLI e2e (`tforge capture export`); MCP tool list test; service route tests incl. auth                                          |
| 3.8 | **Capture UI**: new Capture tab: grouped checklist with progress, tick-off, notes, recording-settings panel, tips with "regenerate", export buttons, Electron save dialog via the preload picker; keyboard and screen-reader friendly                                                                                                                                                                   | Sonnet | Playwright: tick shots off and see progress, edit settings and notes with undo, export a pack and read it back                 |
| 3.9 | **Hardening and docs**: end-to-end (storyboard → capture → tick → export), accessibility pass on the new screens, README capture guide, update this plan and BUILD_LOG; run the desktop smoke on a real machine if available                                                                                                                                                                            | Opus   | `pnpm check` and `pnpm test:e2e` green; review findings fixed                                                                  |

Rough budget: 3.1 and 3.9 Opus, the rest Sonnet (~80% of the milestone); about 80–120k output tokens. Suggested sessions: (1) 3.1 alone on Opus; (2) 3.2–3.4; (3) 3.5–3.7; (4) 3.8; (5) 3.9 on Opus.

## Potential extensions (not scheduled, not in any milestone)

Ideas recorded so they are not lost. None of these is planned work; do not build them or design around them without the user asking.

- **Built-in recording / OBS control** (parked 2026-10-23): a plugin that drives a recorder (for example OBS over its WebSocket API) so a capture checklist item can start, stop and name a recording, and the file attaches to its slot. Today "capture" means the checklist only (M3); the user records in their own tool and M4 imports the files. If ever built, it must stay local-only, be opt-in, and use the same plugin API and typed commands as everything else.
