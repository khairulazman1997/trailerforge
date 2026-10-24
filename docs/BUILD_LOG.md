# Build log

Time and usage per task. Usage is the user's Claude Pro meter (5-hour session % / weekly %) read at checkpoints.

**Timing method.** M1: wall-clock gap between consecutive commits (includes user review and model-switch turnaround). From M2: explicit start/end stamps per task, so "build time" is Claude's working time.

## Milestone 1 — Foundations (2026-10-23, UTC)

| Task                              | Commit                | Finished | Elapsed | Model  | Notes                         |
| --------------------------------- | --------------------- | -------- | ------- | ------ | ----------------------------- |
| Planning + plan docs              | `f58be9d`…`4f2cefc`   | 11:23    | —       | Opus   | Q&A, architecture, approvals  |
| 1.1 Monorepo, CI, Python sidecar  | `09b5a38`             | 11:26    | ~3 min  | Sonnet |                               |
| 1.2 Core schemas                  | `009d8ba`             | 11:33    | ~7 min  | Opus   |                               |
| 1.3 Migrations + knowledge schema | `5d09fd8`             | 11:39    | ~4 min  | Opus   | after plan/CLAUDE.md commits  |
| 1.4 Project store                 | `19e7817`             | 11:44    | ~4 min  | Opus   | torn-tail bug caught by tests |
| 1.6 Job queue                     | `2744eaf`             | 11:51    | ~4 min  | Opus   | 2 ordering/race bugs caught   |
| 1.7 Plugin API                    | `ba0df9f` + `2f1b1fd` | 11:55    | ~4 min  | Opus   | lint fix pushed separately    |
| 1.5 Event bus                     | `4cffad5`             | 11:58    | ~4 min  | Opus   | planned Sonnet; no switch     |
| 1.8 FFmpeg wrapper + Quality Gate | `43c2a3c`             | 12:02    | ~4 min  | Opus   |                               |
| 1.9 LLM adapter                   | `e2309d2`             | 12:06    | ~3 min  | Opus   |                               |
| 1.10 Engine + CLI                 | `4d17b18`             | 12:09    | ~4 min  | Opus   |                               |
| 1.11 README v0                    | `79dfa5f`             | 12:10    | ~1 min  | Opus   |                               |

**M1 total:** ~47 min wall clock from approval to completion; 186 TS + 7 Python tests.

### Usage checkpoints

| When                     | Session | Week | Delta                     |
| ------------------------ | ------- | ---- | ------------------------- |
| Before project           | —       | 20%  |                           |
| After planning + 1.1–1.2 | 32%     | 23%  | +3% week (incl. planning) |
| After 1.3–1.4            | 38%     | 23%  | +6% session               |
| After 1.6–1.7            | 45%     | 24%  | +7% session               |
| After 1.5, 1.8–1.11      | 55%     | 26%  | +10% session, +2% week    |

**M1 cost ≈ 6% of a week** (including planning) and about half of one 5-hour window for the build itself.

## Milestone 2a — Brief, storyboard generation, knowledge (backend)

| Task                                                           | Commit    | Start    | End      | Build time | Model  | Notes                                                                                                          |
| -------------------------------------------------------------- | --------- | -------- | -------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| 2a.1 Game Trailer pack + video types                           | `9246984` | 14:08:02 | 14:10:00 | ~2 min     | Opus   |                                                                                                                |
| 2a.2 Completeness checker, questionnaire, answers, assumptions | `d91e61e` | 14:10:31 | 14:13:37 | ~3 min     | Opus   | design gap found: assumed fields must stay answerable                                                          |
| 2a.3 Storyboard templates (release, announcement, gameplay)    | `4d0a7e0` | 14:16:42 | 14:19:02 | ~2 min     | Sonnet | weight-based builder; optional slots appear in longer cuts; includes `pnpm install`                            |
| 2a.4 Storyboard generation, regenerate section, decision log   | `c30c016` | 14:19:44 | 14:26:36 | ~7 min     | Opus   | found: timeline items reference slots, so replaced slots must be unlinked                                      |
| 2a.5 Anthropic API provider                                    | `62e42b8` | 14:32:00 | 14:33:13 | ~1 min     | Sonnet | structured output + Zod validation; schema-rejection fallback; refusal/truncation errors                       |
| 2a.6 Repo scanner + generic extractor                          | `f0ddc34` | 14:35:40 | 14:39:32 | ~4 min     | Opus   | secrets matched by path before any open; extractor reads limited to scanned files                              |
| 2a.7 Unity extractor                                           | `9d638fb` | 14:43:18 | 14:44:28 | ~1 min     | Sonnet | scenes from build list, ScriptableObjects/prefabs classified by folder                                         |
| 2a.8 Knowledge merge, deep scan, CLI commands, E2E             | `a7bac64` | 14:46:57 | 14:56:33 | ~10 min    | Sonnet | `return await` bug in CLI dispatch caught by E2E; deep scan runs on a sandbox copy                             |
| 2b.1 Storyboard hand-editing commands                          | `3379007` | 14:59:36 | 15:02:43 | ~3 min     | Sonnet | requested after 2a.8; regenerate keeps hand-edited slots                                                       |
| 2b.2 MCP server                                                | `bf21f59` | 15:18:46 | 15:24:31 | ~6 min     | Sonnet | CLI logic moved into engine `ops` so CLI/MCP share it; verified over real stdio                                |
| 2b.3 Local engine service                                      | `c62b3bf` | 15:27:15 | 15:33:36 | ~6 min     | Opus   | SSE over authenticated fetch instead of WebSocket; ops gained cancellation                                     |
| 2b.4 UI scaffold + Playwright smoke                            | `76d5088` | 15:35:36 | 15:46:40 | ~11 min    | Sonnet | service now serves the built UI (CSP, no-token static); render-loop bug caught by e2e; hooks lint added        |
| 2b.5 Brief & intake UI                                         | `aef923b` | 15:49:21 | 15:58:10 | ~9 min     | Sonnet | brief form/answer/suggest/assume added to engine ops + service; date answers route to the release-window field |
| 2b.6 Knowledge UI                                              | `e3365bf` | 16:00:45 | 16:06:40 | ~6 min     | Sonnet | exclude switch made optimistic after e2e caught a flicker/race; service gained claudeBin seam                  |
| 2b.7 Storyboard UI                                             | `e84a311` | 16:11:06 | 16:18:46 | ~8 min     | Sonnet | drag-and-drop e2e needed a tall viewport (no scroll mid-drag); VO/music UI deferred                            |
| 2b.8 Generate / regenerate flows                               | `c44d9d3` | 16:33:06 | 16:41:51 | ~9 min     | Sonnet | task split: settings moved to 2b.9; e2e caught a silently-dead Generate button                                 |
| 2b.9 Settings (UI + backend)                                   | `3d8427f` | 16:51:28 | 17:05    | ~14 min    | Sonnet | key store, routes editor, Chat Handoff relay; one unreproduced e2e failure in 1 of ~6 full runs                |
| 2b.10 Electron shell                                           | `f455b5f` | 17:08:41 | 17:20    | ~12 min    | Sonnet | main-process logic behind a fake host (tested); real launch unverified here; UI does not use the pickers yet   |
| 2b.11 M2 hardening                                             | `d3f27cb` | 17:17:42 | 17:21    | ~5 min     | Opus   | full-flow e2e green first try; desktop review fixes: IPC sender check, basic_text, file split, quit, perms     |

| When (M2a)      | Session    | Week | Note                                      |
| --------------- | ---------- | ---- | ----------------------------------------- |
| After 2a.1–2a.4 | 0% (reset) | 29%  | session window rolled over before reading |
| After 2a.5      | 3%         | 29%  |                                           |
| After 2a.6      | 10%        | 30%  |                                           |
| After 2a.7      | 14%        | 31%  |                                           |
| After 2a.8      | 21%        | 31%  |                                           |
| After 2b.1      | 24%        | 32%  |                                           |
| After 2b.2      | 30%        | 33%  |                                           |
| After 2b.3      | 43%        | 34%  | Opus task: +13% session                   |
| After 2b.4      | 56%        | 36%  | Sonnet UI task: +13% session              |
| After 2b.5      | 63%        | 37%  | Sonnet UI task: +7% session               |
| After 2b.6      | 68%        | 38%  | Sonnet UI task: +5% session               |
| After 2b.7      | 74%        | 39%  | Sonnet UI task: +6% session               |
| After 2b.8      | 81%        | 39%  | Sonnet UI task: +7% session               |
| After 2b.9      | 88%        | 40%  | Sonnet UI + backend: +7% session          |
| After 2b.10     | 91%        | 41%  | Sonnet Electron shell: +3% session        |
| After 2b.11     | 94%        | 41%  | Opus hardening: +3% session               |

## Milestone 3 — Capture Pack (2026-10-24, UTC)

Design defaults confirmed by the user before 3.1: Markdown + printable HTML (PDF via browser print); recording settings from brief platforms + an editable table; capture notes on the slot (`extensions['game-trailer'].capture`); grouping by location → setup → featured entity.

| Task                                   | Commit    | Start    | End      | Build time | Model  | Notes                                                                                                                                                                                                                                                   |
| -------------------------------------- | --------- | -------- | -------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 Capture plan builder               | `2684a95` | 00:25:46 | 00:28:50 | ~3 min     | Opus   | seeded-PRNG property tests (no new dep); locked sections kept (a lock guards content, not recording); skip via ext                                                                                                                                      |
| 3.2 Recording settings                 | `9fdeb76` | 00:42:04 | 00:46:37 | ~5 min     | Sonnet | derived from platforms, video type, HUD needs and format targets; overrides at `extensions['game-trailer'].recording`; MCP exposes the two commands as tools                                                                                            |
| 3.3 Capture commands                   | `e42ab94` | 00:48:04 | 00:50:30 | ~2 min     | Sonnet | status/notes/takes/skip/reorder-group under `game-trailer/capture.*`; work in locked sections; no storyboard revision bump                                                                                                                              |
| 3.4 Setup hints                        | `a43fcde` | 00:52:24 | 00:53:46 | ~4 min     | Sonnet | derived hints from knowledge; debug commands and save files are tag-driven because the Unity extractor does not detect them; `forLlm` drops excluded entities                                                                                           |
| 3.5 Capture tips (LLM)                 | `070d00a` | 00:55:24 | ENDT     | ~ENDM min  | Sonnet | returns an apply payload, stores nothing on cancel; prompt uses opaque group aliases because real keys embed entity ids (the leak guard caught it); redaction of excluded names/ids/paths + a final guard                                               |
| 3.4b Unity debug commands + save files | `1b68641` | 01:03:21 | 01:08:02 | ~5 min     | Opus   | `ExtractedEntity.tags` + tag-union merge; C# comment-stripping lexer; console attributes/AddCommand, Mirror `[Command]` excluded; persistentDataPath/ES3/PlayerPrefs with Windows paths; names only, never string contents                              |
| 3.6 Pack export                        | `a16c604` | 01:11:46 | ENDT     | ~ENDM min  | Sonnet | `buildCapturePack` (pure) + Markdown/HTML/JSON renderers + atomic writer under `exports/capture/`; `omitExcluded` redacts excluded names inside other text and aliases group keys; golden files via `UPDATE_GOLDEN=1`; HTML checked offline in Chromium |
| 3.7 Engine ops, service, CLI, MCP      | `HASH`    | 01:16:39 | 01:22:08 | ~6 min     | Sonnet | `capture-ops.ts` (view/status/settings/mark/tips/export), service routes + `capture-tips` task + `capture.tips` preview, `tforge capture ...`, 5 MCP tools; mutating commands reuse the generic command route and MCP command tools                     |

| When (M3)  | Session | Week | Note           |
| ---------- | ------- | ---- | -------------- |
| Before 3.1 | 0%      | 42%  |                |
| After 3.1  | 4%      | 42%  | Opus task      |
| After 3.2  | —       | —    | user to report |
| After 3.3  | —       | —    | user to report |
| After 3.4  | —       | —    | user to report |
| After 3.5  | —       | —    | user to report |
| After 3.4b | —       | —    | user to report |
| After 3.6  | —       | —    | user to report |
| After 3.7  | —       | —    | user to report |
