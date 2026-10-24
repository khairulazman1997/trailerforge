"""Synthetic media with known ground truth, generated at test time (no binary fixtures)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

SR = 44100


def _burst(freq: float, length_s: float, amp: float) -> np.ndarray:
    t = np.arange(int(SR * length_s)) / SR
    return (amp * np.sin(2 * np.pi * freq * t) * np.exp(-t * 40)).astype(np.float32)


def click_track(
    bpm: float, bars: int, first_beat_s: float = 0.5, loud_from_bar: int | None = None
) -> tuple[np.ndarray, list[float], list[float]]:
    """4/4 clicks: a low thump plus click on beat 1, a high click on 2-4.

    Returns (samples, beat times, downbeat times). From `loud_from_bar` on, a chord pad and a
    louder mix make an obvious second section.
    """
    beat = 60.0 / bpm
    total = first_beat_s + bars * 4 * beat + 1.0
    y = np.zeros(int(SR * total), dtype=np.float32)
    beats, downs = [], []
    for i in range(bars * 4):
        t = first_beat_s + i * beat
        beats.append(t)
        start = round(t * SR)
        loud = loud_from_bar is not None and i // 4 >= loud_from_bar
        gain = 1.0 if loud else 0.35
        if i % 4 == 0:
            downs.append(t)
            hit = _burst(60, 0.15, 0.9 * gain)
            hit[: int(SR * 0.03)] += _burst(1500, 0.03, 0.4 * gain)
        else:
            hit = _burst(2500, 0.03, 0.5 * gain)
        y[start : start + len(hit)] += hit
    if loud_from_bar is not None:
        a = int((first_beat_s + loud_from_bar * 4 * beat) * SR)
        t = np.arange(len(y) - a) / SR
        pad = sum(np.sin(2 * np.pi * f * t) for f in (220.0, 277.18, 329.63)) * 0.08
        y[a:] += pad.astype(np.float32)
    return np.clip(y, -1, 1), beats, downs


def write_audio(y: np.ndarray, path: Path) -> Path:
    """Encode float samples with FFmpeg; the extension picks the format (.wav, .m4a, .mp3)."""
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "f32le",
            "-ar",
            str(SR),
            "-ac",
            "1",
            "-i",
            "-",
            str(path),
        ],
        input=y.astype("<f4").tobytes(),
        check=True,
    )
    return path


def write_video(frames: list[np.ndarray], path: Path, fps: int = 30) -> Path:
    h, w = frames[0].shape[:2]
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{w}x{h}",
            "-r",
            str(fps),
            "-i",
            "-",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "8",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        input=b"".join(f.astype(np.uint8).tobytes() for f in frames),
        check=True,
    )
    return path


def moving(pattern: str, n: int, start: int = 0, w: int = 320, h: int = 180) -> list[np.ndarray]:
    """Frames with steady motion. `checker`: moving squares; `bars`: moving colour bars."""
    out = []
    yy, xx = np.mgrid[0:h, 0:w]
    for i in range(start, start + n):
        if pattern == "checker":
            v = (((xx + 4 * i) // 20 + yy // 20) % 2) * 180 + 40
            f = np.stack([v, v * 0.6, v * 0.3], axis=-1)
        else:
            v = ((xx + 6 * i) // 40) % 4
            f = np.stack([(v == 0) * 200 + 30, (v == 1) * 200 + 30, (v >= 2) * 200 + 30], axis=-1)
        out.append(f.astype(np.uint8))
    return out


def solid(value: int, n: int, w: int = 320, h: int = 180) -> list[np.ndarray]:
    return [np.full((h, w, 3), value, dtype=np.uint8) for _ in range(n)]
