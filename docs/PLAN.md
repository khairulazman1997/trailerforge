# TrailerForge — Architecture Plan

Status: **approved 2026-10-23**. Model approach: **manual switching** (Opus only where needed, Sonnet otherwise). Motion engine: **option A** (EffectCraft optional plugin, M5b, after spike).

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Shell | Electron + React + TypeScript (Win/macOS/Linux). Engine runs as a local Node service, so the UI also runs in a browser ("web mode") for headless dev/testing. |
| 2 | LLM | Provider-agnostic adapter: Anthropic (default), OpenAI, Ollama, deterministic Mock, and **Chat Handoff** (copy a self-contained prompt into a chat, paste the JSON reply back; validated + "fix these errors" follow-up). |
| 3 | Paid APIs | LLM only. All analysis local (faster-whisper, PySceneDetect, librosa, OpenCV). |
| 4 | Hardware | CPU baseline; NVENC / VideoToolbox / QSV / VAAPI used when detected. |
| 5 | Licensing | Closed-source-compatible: system/user-installed FFmpeg detected at runtime; avoid Essentia (AGPL) and Remotion (company license); graphics via `@napi-rs/canvas`. |
| 6 | Reference videos | Local upload primary; URL download via user-installed `yt-dlp`, explicit opt-in. Structure only. |
| 7 | Demo assets | Procedurally generated synthetic footage + music (known ground truth for tests). |
| 8 | Repo | pnpm + Turborepo monorepo in this repository. |

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

| Milestone | Lead |
|---|---|
| M1 Foundations | Opus (~70%) |
| M2 Intake + storyboard | Mixed |
| M3 Capture Pack | Sonnet (~80%) |
| M4 Ingest + auto-cut | Opus (~75%) |
| M5 Variants + graphics | Mixed |
| M6 Review + render | Mixed |
| M7 Polish | Sonnet (~65%) |
| M8 Planner scaffold | Sonnet (~85%) |

### In-app defaults (`llm.routes.json`, user-editable)

| Task | Model / effort |
|---|---|
| Brief parsing | Haiku 5.5 / low |
| Completeness scoring | No LLM (rules) |
| "Suggest for me" | Sonnet 5.5 / low |
| Full storyboard | Opus 5.5 / high |
| Section regenerate | Sonnet 5.5 / medium |
| VO script | Opus 5.5 / medium |
| Capture Pack | Deterministic + Sonnet 5.5 / low for tips |
| Reference → template | Sonnet 5.5 / medium |
| AI critique | Opus 5.5 / high |
| Decision explanations | No LLM |

## Build token estimates (rough; refined before each milestone)

| Milestone | Output tokens | Total processed |
|---|---|---|
| M1 | 135–195k | 11–19M |
| M2 | 180–260k | 15–25M |
| M3 | 80–120k | 6–10M |
| M4 | 230–345k | 23–40M |
| M5 | 170–255k | 17–29M |
| M6 | 230–320k | 21–35M |
| M7 | 120–200k | 12–20M |
| M8 | 50–80k | 4–8M |

Plan: pause after M1 tasks 1.1–1.2 to read actual plan usage % and extrapolate.

## Milestone 1 — Foundations

| # | Task | Acceptance |
|---|---|---|
| 1.1 | Monorepo scaffold, TS strict, lint, Vitest, CI; Python sidecar (uv, pytest) | Clean `pnpm build && pnpm test`; sidecar `ping` |
| 1.2 | `schema` package (all core schemas + campaign fields) | Round-trip/validation tests; JSON Schema export |
| 1.3 | Versioning + migrations | v0→v1 sample migration with backup |
| 1.4 | ProjectStore: atomic save, autosave, JSON-patch history, command bus, undo/redo | Crash-safety + undo/redo tests |
| 1.5 | Typed event bus | Subscribe/unsubscribe/error-isolation tests |
| 1.6 | Persistent job queue | Survives restart, resumes from checkpoint, cancel cleans temp |
| 1.7 | Plugin API + loader | Sample plugin registers video type + preset; broken plugin isolated |
| 1.8 | `media` wrapper: probe, capabilities/hwaccel, proxies/thumbs, filtergraph builder, typed errors, **loudness/peak measurement + Quality Gate framework** | Tests on generated fixtures; every error path tested |
| 1.9 | `llm` adapter: providers incl. Mock + **Chat Handoff**, prompt loader, validate/repair, `llm.routes.json` | Contract tests with Mock and Handoff |
| 1.10 | Engine + CLI (`new/open/probe/jobs`) | Smoke e2e: create → save → reload → probe |
| 1.11 | README v0 | Setup, Mermaid architecture diagram, plugin stub guide |
