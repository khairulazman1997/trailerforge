"""Footage analysis: scene changes, brightness and motion per frame, black, flash and frozen frames.

Works on small frames at a constant rate (see `decode.iter_frames`), so frame i is exactly at
i / rate seconds. Results are frame indices; the TypeScript side converts them to flicks.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .decode import iter_frames
from .rpc import AnalysisError, Progress

SIZE = (128, 72)
BLACK_MEAN = 20.0  # TV-range black is 16
BLACK_STD = 8.0
FLASH_JUMP = 60.0
FROZEN_MOTION = 0.5  # mean absolute luma difference between frames
FROZEN_MIN_S = 0.5


def _runs(mask: list[bool]) -> list[tuple[int, int]]:
    """[start, end) of each run of True."""
    out: list[tuple[int, int]] = []
    start = None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(mask)))
    return out


def _flashes(bright: list[float]) -> list[int]:
    """Frames in runs of at most two that are much brighter than the frames around them."""
    n = len(bright)
    out: list[int] = []
    i = 0
    while i < n:
        for length in (1, 2):
            j = i + length
            if j > n:
                continue
            around = [bright[k] for k in (i - 1, j) if 0 <= k < n]
            if around and all(bright[k] >= max(around) + FLASH_JUMP for k in range(i, j)):
                out.extend(range(i, j))
                i = j
                break
        else:
            i += 1
    return out


def analyze_footage(params: dict[str, Any], progress: Progress) -> dict[str, Any]:
    import cv2
    from scenedetect import FrameTimecode
    from scenedetect.detectors import ContentDetector

    path = params["path"]
    num, den = int(params["rate"]["num"]), int(params["rate"]["den"])
    fps = num / den
    expected = max(1, round(float(params.get("duration") or 0) * fps))
    detector = ContentDetector(min_scene_len=max(1, round(0.25 * fps)))

    bright: list[float] = []
    std: list[float] = []
    motion: list[float] = []
    cuts: list[int] = []
    prev = None
    last_tc = None
    for i, frame in enumerate(
        iter_frames(path, (num, den), SIZE, params.get("ffmpeg") or "ffmpeg")
    ):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        bright.append(float(gray.mean()))
        std.append(float(gray.std()))
        g16 = gray.astype(np.int16)
        motion.append(0.0 if prev is None else float(np.abs(g16 - prev).mean()))
        prev = g16
        last_tc = FrameTimecode(i, fps)
        cuts.extend(tc.frame_num for tc in detector.process_frame(last_tc, frame))
        if i % 30 == 0:
            progress(min(0.99, i / expected))
    if last_tc is None:
        raise AnalysisError("no-video", "no video frames could be read")
    cuts.extend(tc.frame_num for tc in detector.post_process(last_tc))

    n = len(bright)
    black = [bright[i] <= BLACK_MEAN and std[i] <= BLACK_STD for i in range(n)]
    min_frozen = max(2, math.ceil(FROZEN_MIN_S * fps))
    still = [i > 0 and motion[i] < FROZEN_MOTION and not black[i] for i in range(n)]
    # A run of still differences k..m means frames k-1..m are the same picture.
    frozen = [(s - 1, e) for s, e in _runs(still) if e - (s - 1) >= min_frozen]
    progress(1.0)
    return {
        "rate": {"num": num, "den": den},
        "frameCount": n,
        "scenes": sorted({int(c) for c in cuts if 0 < c < n}),
        "black": [list(r) for r in _runs(black)],
        "flashes": _flashes(bright),
        "frozen": [list(r) for r in frozen],
        "brightness": [round(b) for b in bright],
        "motion": [round(m * 10) for m in motion],
    }
