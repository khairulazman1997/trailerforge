"""Decoding through FFmpeg pipes, so every container FFmpeg reads works and timing is exact."""

from __future__ import annotations

import subprocess
from collections.abc import Iterator

import numpy as np

from .rpc import AnalysisError


def read_audio(path: str, sample_rate: int, ffmpeg: str = "ffmpeg") -> np.ndarray:
    """Whole file as mono float32 at `sample_rate`."""
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise AnalysisError("ffmpeg-missing", f"FFmpeg not found: {ffmpeg}") from exc
    if proc.returncode != 0:
        msg = proc.stderr.decode(errors="replace").strip().splitlines()[-1:] or ["unknown error"]
        raise AnalysisError("decode-failed", f"cannot decode audio: {msg[0]}")
    return np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32)


def iter_frames(
    path: str, rate: tuple[int, int], size: tuple[int, int], ffmpeg: str = "ffmpeg"
) -> Iterator[np.ndarray]:
    """Frames as small BGR arrays at a constant `rate` (num, den): frame i is at i * den / num s.

    Variable-frame-rate sources are resampled to the constant rate, so frame indices map to time
    exactly and the same file always gives the same frames.
    """
    w, h = size
    num, den = rate
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-vf",
        f"fps={num}/{den},scale={w}:{h}:flags=area",
        "-pix_fmt",
        "bgr24",
        "-f",
        "rawvideo",
        "-",
    ]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError as exc:
        raise AnalysisError("ffmpeg-missing", f"FFmpeg not found: {ffmpeg}") from exc
    frame_bytes = w * h * 3
    assert proc.stdout is not None
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        code = proc.wait()
    if code != 0:
        raise AnalysisError("decode-failed", f"cannot decode video: {err.strip()[-200:]}")
