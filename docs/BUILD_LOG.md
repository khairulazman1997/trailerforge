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

| Task | Commit | Start | End | Build time | Model | Notes |
| ---- | ------ | ----- | --- | ---------- | ----- | ----- |
