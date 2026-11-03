"""Measurements of a reference clip for "effect from an example" (TrailerForge plan M8, decision 10).

Only these numbers leave the machine (as text), never the clip: its length, the moments where
something appears, flashes, cuts or fades, its main colours, and which way and how fast things
move. Everything is computed on small frames at a fixed rate, so the same file always gives the
same facts.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np

from .decode import AnalysisError, iter_frames

Progress = Callable[[float], None]

RATE = (15, 1)
SIZE = (160, 90)
NEAR_BLACK = 20.0
FLASH_JUMP = 40.0
CUT_DIFF = 40.0
STILL_DIFF = 1.0
APPEAR_DIFF = 4.0
MOVING_PIXEL = 12


def _r(x: float) -> float:
    return round(float(x), 3)


def _colors(samples: list[np.ndarray], top: int = 5) -> list[dict[str, Any]]:
    """Main colours: every pixel quantised to 4 bits a channel, the most common bins."""
    if not samples:
        return []
    px = np.concatenate([s.reshape(-1, 3) for s in samples]).astype(np.int32) >> 4
    keys = (px[:, 2] << 8) | (px[:, 1] << 4) | px[:, 0]  # BGR frames → RGB key
    counts = np.bincount(keys, minlength=4096)
    order = sorted(range(4096), key=lambda k: (-int(counts[k]), k))
    out = []
    for k in order[:top]:
        share = counts[k] / len(keys)
        if share < 0.02:
            break
        r, g, b = ((k >> 8) & 15) * 17, ((k >> 4) & 15) * 17, (k & 15) * 17
        out.append({"hex": f"#{r:02x}{g:02x}{b:02x}", "share": _r(share)})
    return out


def analyze_reference(params: dict[str, Any], progress: Progress) -> dict[str, Any]:
    path = params["path"]
    num, den = RATE
    fps = num / den
    bright: list[float] = []
    diffs: list[float] = []
    centroids: list[tuple[float, float] | None] = []
    samples: list[np.ndarray] = []
    prev = None
    for i, frame in enumerate(iter_frames(path, RATE, SIZE, params.get("ffmpeg") or "ffmpeg")):
        f = frame.astype(np.int32)
        gray = (f[:, :, 2] * 299 + f[:, :, 1] * 587 + f[:, :, 0] * 114) // 1000
        bright.append(float(gray.mean()))
        if i % 3 == 0:
            samples.append(frame)
        if prev is None:
            diffs.append(0.0)
            centroids.append(None)
        else:
            d = np.abs(gray - prev)
            diffs.append(float(d.mean()))
            ys, xs = np.nonzero(d > MOVING_PIXEL)
            centroids.append(
                None if len(xs) < 8 else (float(xs.mean()) / SIZE[0], float(ys.mean()) / SIZE[1])
            )
        prev = gray
        if i % 30 == 0:
            progress(min(0.99, i / max(1.0, float(params.get("duration") or 10) * fps)))
    n = len(bright)
    if n == 0:
        raise AnalysisError("no-video", "no video frames could be read")

    def t(i: int) -> float:
        return _r(i / fps)

    events: list[dict[str, Any]] = []
    window = max(1, round(0.3 * fps))
    i = 1
    while i < n:
        jump = bright[i] - bright[i - 1]
        back = next(
            (
                j
                for j in range(i + 1, min(n, i + window + 1))
                if bright[j] < bright[i] - FLASH_JUMP / 2
            ),
            None,
        )
        if jump > FLASH_JUMP and back is not None:
            events.append({"kind": "flash", "at": t(i)})
            i = back + 1
            continue
        if diffs[i] > CUT_DIFF:
            events.append({"kind": "cut", "at": t(i)})
        elif (
            diffs[i] > APPEAR_DIFF
            and all(d < STILL_DIFF for d in diffs[max(1, i - window) : i])
            and i >= window
        ):
            events.append({"kind": "appear", "at": t(i)})
        i += 1
    # Fades: a steady rise out of (or fall into) near black over at least 0.3 s.
    for kind, start_dark in (("fade-in", True), ("fade-out", False)):
        k = 0
        while k < n - 1:
            if (bright[k] < NEAR_BLACK) == start_dark:
                j = k
                step = 1 if start_dark else -1
                while j + 1 < n and (bright[j + 1] - bright[j]) * step > 0.5:
                    j += 1
                lit = bright[j] if start_dark else bright[k]
                dark_end = bright[k] if start_dark else bright[j]
                if j - k >= window and lit > NEAR_BLACK * 3 and (dark_end < NEAR_BLACK):
                    events.append({"kind": kind, "from": t(k), "to": t(j)})
                    k = j
            k += 1
    events.sort(key=lambda e: (e.get("at", e.get("from")), e["kind"]))

    moving = [(i, c) for i, c in enumerate(centroids) if c is not None]
    motion: dict[str, Any] = {"direction": "still", "speed": 0.0, "share": _r(len(moving) / n)}
    if len(moving) >= 2:
        (i0, a), (i1, b) = moving[0], moving[-1]
        dx, dy = b[0] - a[0], b[1] - a[1]
        secs = max(1 / fps, (i1 - i0) / fps)
        if max(abs(dx), abs(dy)) >= 0.05:
            motion["direction"] = (
                ("right" if dx > 0 else "left")
                if abs(dx) >= abs(dy)
                else ("down" if dy > 0 else "up")
            )
            motion["speed"] = _r(max(abs(dx), abs(dy)) / secs)
    progress(1.0)
    return {
        "seconds": t(n),
        "frameCount": n,
        "rate": {"num": num, "den": den},
        "colors": _colors(samples),
        "brightness": {"min": _r(min(bright)), "max": _r(max(bright)), "mean": _r(sum(bright) / n)},
        "events": events[:40],
        "motion": motion,
    }
