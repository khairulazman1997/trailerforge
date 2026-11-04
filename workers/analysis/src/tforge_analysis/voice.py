"""Voiceover: a loudness envelope and word-timed transcription (opt-in model; CPU, offline).

`voice.envelope` needs no model: the loudness of the recording every 10 ms, which the app uses to
trim breaths and silence around each line. `voice.transcribe` also runs faster-whisper (a
CTranslate2 Whisper model, int8 on the CPU) from a folder the app downloaded and verified
beforehand, and returns every word with its start and end. Decoding is greedy at temperature 0
with no conditioning on earlier text, so the same file gives the same words. Nothing here
touches the network: the model is loaded from its folder only.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .decode import read_audio
from .rpc import AnalysisError, Progress

SAMPLE_RATE = 16_000
HOP_S = 0.01
FLOOR_DB = -90.0
MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")


def envelope_db(y: np.ndarray, sr: int = SAMPLE_RATE, hop_s: float = HOP_S) -> list[float]:
    """RMS level in dBFS per `hop_s` window (the last window may be short), one decimal."""
    hop = max(1, round(sr * hop_s))
    n = int(np.ceil(len(y) / hop)) if len(y) else 0
    if n == 0:
        return []
    padded = np.zeros(n * hop, dtype=np.float64)
    padded[: len(y)] = y
    rms = np.sqrt(np.mean(padded.reshape(n, hop) ** 2, axis=1))
    db = 20.0 * np.log10(np.maximum(rms, 10 ** (FLOOR_DB / 20)))
    return [round(float(v), 1) for v in db]


def _audio(params: dict[str, Any]) -> np.ndarray:
    return read_audio(params["path"], SAMPLE_RATE, params.get("ffmpeg") or "ffmpeg")


def envelope(params: dict[str, Any], progress: Progress) -> dict[str, Any]:
    y = _audio(params)
    progress(0.9)
    return {
        "duration": round(len(y) / SAMPLE_RATE, 4),
        "envelope": {"hop": HOP_S, "db": envelope_db(y)},
    }


def _load_model(model_dir: Path):
    from faster_whisper import WhisperModel

    return WhisperModel(str(model_dir), device="cpu", compute_type="int8", cpu_threads=0)


def transcribe(params: dict[str, Any], progress: Progress, load=_load_model) -> dict[str, Any]:
    d = Path(params["modelDir"])
    missing = [f for f in MODEL_FILES if not (d / f).is_file()]
    if missing:
        raise AnalysisError("model-missing", f"voice model files missing: {', '.join(missing)}")
    y = _audio(params)
    duration = len(y) / SAMPLE_RATE
    progress(0.05)
    model = load(d)
    progress(0.15)
    language = params.get("language") or None
    prompt = params.get("prompt") or None
    segments, info = model.transcribe(
        y,
        language=language,
        task="transcribe",
        beam_size=1,
        best_of=1,
        temperature=0.0,
        condition_on_previous_text=False,
        word_timestamps=True,
        vad_filter=False,
        initial_prompt=prompt,
    )
    words: list[dict[str, Any]] = []
    texts: list[dict[str, Any]] = []
    for seg in segments:
        texts.append(
            {"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()}
        )
        for w in seg.words or []:
            text = w.word.strip()
            if not text:
                continue
            words.append(
                {
                    "start": round(float(w.start), 3),
                    "end": round(float(max(w.end, w.start)), 3),
                    "text": text,
                    "p": round(float(w.probability), 3),
                }
            )
        if duration > 0:
            progress(0.15 + 0.8 * min(1.0, seg.end / duration))
    return {
        "duration": round(duration, 4),
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 3),
        "segments": texts,
        "words": words,
        "envelope": {"hop": HOP_S, "db": envelope_db(y)},
    }
