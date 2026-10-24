"""Music analysis: tempo, beats, downbeats (4/4), onsets, energy and sections.

Times are seconds; the TypeScript side converts them to flicks at one boundary. Deterministic:
the same file always gives the same result.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .decode import read_audio
from .rpc import AnalysisError, Progress

SR = 22050
HOP = 512
FINE_HOP = 128
BEATS_PER_BAR = 4
ENERGY_HOP_S = 0.1


def _refine(beats: np.ndarray, fine_env: np.ndarray, window_s: float = 0.04) -> np.ndarray:
    """Snap each beat to the strongest fine-resolution onset within +-window."""
    if len(beats) == 0:
        return beats
    fine_t = np.arange(len(fine_env)) * FINE_HOP / SR
    out = beats.copy()
    for i, b in enumerate(beats):
        lo, hi = np.searchsorted(fine_t, [b - window_s, b + window_s])
        if hi > lo:
            out[i] = fine_t[lo + int(np.argmax(fine_env[lo:hi]))]
    return out


def _extend(beats: np.ndarray, fine_env: np.ndarray, duration: float) -> np.ndarray:
    """Continue the beat grid into quiet intros and outros that the tracker trims as weak.

    Steps one beat period at a time beyond each end while there is an onset near the expected
    time at least a tenth as strong as a typical tracked beat.
    """
    if len(beats) < 4:
        return beats
    period = float(np.median(np.diff(beats)))
    fine_t = np.arange(len(fine_env)) * FINE_HOP / SR
    idx = np.clip(np.searchsorted(fine_t, beats), 0, len(fine_env) - 1)
    floor = 0.1 * float(np.median(fine_env[idx]))

    def find(t: float) -> float | None:
        lo, hi = np.searchsorted(fine_t, [t - 0.04, t + 0.04])
        if hi <= lo:
            return None
        k = lo + int(np.argmax(fine_env[lo:hi]))
        return float(fine_t[k]) if fine_env[k] >= floor and fine_env[k] > 0 else None

    head: list[float] = []
    t = float(beats[0])
    while t - period >= 0 and (found := find(t - period)) is not None:
        head.insert(0, found)
        t = found
    tail: list[float] = []
    t = float(beats[-1])
    while t + period <= duration and (found := find(t + period)) is not None:
        tail.append(found)
        t = found
    return np.array([*head, *beats.tolist(), *tail])


def _downbeat_phase(y: np.ndarray, beats: np.ndarray) -> int:
    """Which of the first four beats starts a bar: the phase with the most low-end weight."""
    import librosa

    if len(beats) < BEATS_PER_BAR * 2:
        return 0
    spec = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    low = spec[freqs < 200].sum(axis=0)
    frames = librosa.time_to_frames(beats, sr=SR, hop_length=HOP)
    weight = np.array([low[max(0, f - 2) : f + 3].max(initial=0.0) for f in frames])
    scores = [weight[p::BEATS_PER_BAR].mean() for p in range(BEATS_PER_BAR)]
    return int(np.argmax(scores))


def _sections(y: np.ndarray, downbeats: np.ndarray, duration: float) -> list[dict[str, float]]:
    """Bar-aligned sections from agglomerative clustering of bar-synchronous features."""
    import librosa

    bounds = [0.0, *[float(t) for t in downbeats if 0 < t < duration], duration]
    bounds = sorted(set(bounds))
    bars = len(bounds) - 1
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    t = librosa.frames_to_time(np.arange(len(rms)), sr=SR, hop_length=HOP)
    peak = float(rms.max()) or 1.0

    def energy(a: float, b: float) -> float:
        m = (t >= a) & (t < b)
        return round(100 * float(rms[m].mean()) / peak) if m.any() else 0

    k = int(min(8, max(2, round(duration / 20)), bars))
    if bars < 4 or k < 2:
        return [{"start": 0.0, "end": duration, "energy": energy(0.0, duration)}]
    mfcc = librosa.feature.mfcc(y=y, sr=SR, hop_length=HOP, n_mfcc=13)
    chroma = librosa.feature.chroma_stft(y=y, sr=SR, hop_length=HOP)
    feats = np.vstack([librosa.util.normalize(mfcc, axis=1), chroma, rms[np.newaxis, :] / peak])
    bar_frames = librosa.time_to_frames(np.array(bounds), sr=SR, hop_length=HOP)
    sync = librosa.util.sync(feats, bar_frames[:-1].tolist(), aggregate=np.mean)
    sync = sync[:, :bars]
    starts = librosa.segment.agglomerative(sync, k)
    edges = [bounds[int(i)] for i in starts] + [duration]
    return [
        {"start": edges[i], "end": edges[i + 1], "energy": energy(edges[i], edges[i + 1])}
        for i in range(len(edges) - 1)
        if edges[i + 1] > edges[i]
    ]


def analyze_music(params: dict[str, Any], progress: Progress) -> dict[str, Any]:
    import librosa

    path = params["path"]
    y = read_audio(path, SR, params.get("ffmpeg") or "ffmpeg")
    duration = len(y) / SR
    if duration < 1.0:
        raise AnalysisError("too-short", "the track is shorter than a second")
    progress(0.15)
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    fine = librosa.onset.onset_strength(y=y, sr=SR, hop_length=FINE_HOP)
    progress(0.35)
    if float(np.max(np.abs(y))) < 1e-4:
        raise AnalysisError("silent", "the track is silent")
    _, beat_frames = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP)
    beats = _refine(librosa.frames_to_time(beat_frames, sr=SR, hop_length=HOP), fine)
    beats = _extend(beats, fine, duration)
    progress(0.6)
    tempo = float(60.0 / np.median(np.diff(beats))) if len(beats) > 1 else 0.0
    phase = _downbeat_phase(y, beats)
    downbeats = beats[phase::BEATS_PER_BAR]
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=HOP, units="time")
    progress(0.75)
    hop = int(SR * ENERGY_HOP_S)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop, center=True)[0]
    peak = float(rms.max()) or 1.0
    sections = _sections(y, downbeats, duration)
    progress(1.0)
    return {
        "sampleRate": SR,
        "duration": duration,
        "tempo": round(tempo, 3),
        "beats": [round(float(b), 6) for b in beats],
        "downbeats": [round(float(b), 6) for b in downbeats],
        "beatsPerBar": BEATS_PER_BAR,
        "onsets": [round(float(o), 6) for o in onsets],
        "energy": {"hop": ENERGY_HOP_S, "values": [round(100 * float(v) / peak) for v in rms]},
        "sections": [
            {"start": round(s["start"], 6), "end": round(s["end"], 6), "energy": s["energy"]}
            for s in sections
        ],
    }
