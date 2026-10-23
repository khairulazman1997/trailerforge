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

| Task                                                           | Commit    | Start    | End      | Build time | Model  | Notes                                                                                    |
| -------------------------------------------------------------- | --------- | -------- | -------- | ---------- | ------ | ---------------------------------------------------------------------------------------- |
| 2a.1 Game Trailer pack + video types                           | `9246984` | 14:08:02 | 14:10:00 | ~2 min     | Opus   |                                                                                          |
| 2a.2 Completeness checker, questionnaire, answers, assumptions | `d91e61e` | 14:10:31 | 14:13:37 | ~3 min     | Opus   | design gap found: assumed fields must stay answerable                                    |
| 2a.3 Storyboard templates (release, announcement, gameplay)    | `4d0a7e0` | 14:16:42 | 14:19:02 | ~2 min     | Sonnet | weight-based builder; optional slots appear in longer cuts; includes `pnpm install`      |
| 2a.4 Storyboard generation, regenerate section, decision log   | `c30c016` | 14:19:44 | 14:26:36 | ~7 min     | Opus   | found: timeline items reference slots, so replaced slots must be unlinked                |
| 2a.5 Anthropic API provider                                    | `62e42b8` | 14:32:00 | 14:33:13 | ~1 min     | Sonnet | structured output + Zod validation; schema-rejection fallback; refusal/truncation errors |
| 2a.6 Repo scanner + generic extractor                          | `f0ddc34` | 14:35:40 | 14:39:32 | ~4 min     | Opus   | secrets matched by path before any open; extractor reads limited to scanned files        |
| 2a.7 Unity extractor                                           | `9d638fb` | 14:43:18 | 14:44:28 | ~1 min     | Sonnet | scenes from build list, ScriptableObjects/prefabs classified by folder                   |
| 2a.8 Knowledge merge, deep scan, CLI commands, E2E             | `a7bac64` | 14:46:57 | 14:56:33 | ~10 min    | Sonnet | `return await` bug in CLI dispatch caught by E2E; deep scan runs on a sandbox copy       |
| 2b.1 Storyboard hand-editing commands                          | `3379007` | 14:59:36 | 15:02:43 | ~3 min     | Sonnet | requested after 2a.8; regenerate keeps hand-edited slots                                 |

| When (M2a)      | Session    | Week | Note                                      |
| --------------- | ---------- | ---- | ----------------------------------------- |
| After 2a.1–2a.4 | 0% (reset) | 29%  | session window rolled over before reading |
| After 2a.5      | 3%         | 29%  |                                           |
| After 2a.6      | 10%        | 30%  |                                           |
| After 2a.7      | 14%        | 31%  |                                           |
| After 2a.8      | 21%        | 31%  |                                           |
| After 2b.1      | 24%        | 32%  |                                           |
