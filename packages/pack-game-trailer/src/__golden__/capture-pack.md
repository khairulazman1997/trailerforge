# Ember Knight — Release Trailer — capture pack

1 of 2 shots recorded · about 6 s of footage still to record · storyboard revision 0

## Recording settings

| Setting | Value | |
| --- | --- | --- |
| Resolution | 3840×2160 | derived |
| Frame rate | 60 fps, constant | derived |
| Bitrate | 140 Mbps | derived |
| Codec | HEVC | derived |
| Container | MKV | derived |
| HUD | off | derived |
| HDR | off (record SDR) | derived |

- **Watch out:** Record at a constant frame rate (CFR). Variable frame rate drifts out of sync with audio and makes cuts land between frames.
- **Note:** Use an HDMI capture card at full quality. A console's built-in share or clip feature is heavily compressed and not suited to trailer footage.
- **Watch out:** Xbox Game Bar and GPU overlay recorders often capture variable frame rate; prefer OBS with a fixed FPS.
- **Note:** A listed platform can output HDR. Record SDR unless you deliver HDR; HDR footage looks washed out unless tone-mapped to SDR.

## Setup that applies everywhere

Debug commands:
- **spawn\_boss** — Debug console command: `spawn_boss <phase>`

Save files:
- **slot1.sav** — Windows: %USERPROFILE%\\AppData\\LocalLow\\Ember\\slot1.sav

## Checklist

Put the shot code in the recording’s file name and TrailerForge matches the file to its shot when you import it; add “take2” for a second take. For example: `TF-ZXV5G take2.mp4`.

### 1. Forest · The Ash Warden (1/1)

Level:
- **Cinder Forest**

Debug commands:
- **warp\_forest** — Debug console command: `warp forest` (Cinder Forest)

- [x] **Boss reveal** (`TF-ZXV5G`, Escalation) — record 7 s · 2.5 s cut (2–4 s) · HUD any
  - Do: Wait for the intro cinematic, then walk into the arena.
  - Features: The Ash Warden, Cinder Forest

### 2. Forest (0/1)

Level:
- **Cinder Forest**

Debug commands:
- **warp\_forest** — Debug console command: `warp forest` (Cinder Forest)

Tips:
- Start from the checkpoint to save loading time.

Risks:
- An autosave popup can ruin a take.

- [ ] **Perfect parry** (`TF-PX9B8`, Hook) — record 6 s · 2 s cut (1.5–3 s) · HUD off
  - Do: Boss phase 2: land a parry then a finisher. No HUD.
  - Why: Show the core mechanic in the first 3 seconds
  - Alternates: Parry the \_first\_ strike instead
  - Notes: Use \<take 2\> & "quotes" \| pipe \*star\* \[link\](x)
  - Takes: 3

## Skipped shots

- Cut scene (`shot_skip`)
