"""Local image/text embeddings with a CLIP-style ONNX model (opt-in; runs on the CPU, offline).

The model folder holds `vision.onnx`, `text.onnx` and `tokenizer.json`, downloaded and verified
by the app beforehand. This module never touches the network: tokenizers are read from file,
never fetched. Vectors are L2-normalised, so a dot product is the cosine similarity.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import numpy as np

from .rpc import AnalysisError, Progress

SIZE = 224
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
MAX_TOKENS = 77
FILES = ("vision.onnx", "text.onnx", "tokenizer.json")


def _model_dir(params: dict[str, Any]) -> Path:
    d = Path(params["modelDir"])
    missing = [f for f in FILES if not (d / f).is_file()]
    if missing:
        raise AnalysisError("model-missing", f"vision model files missing: {', '.join(missing)}")
    return d


def _session(path: Path):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 0  # all cores
    return ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])


def _run(session, feeds: dict[str, np.ndarray], prefer: str) -> np.ndarray:
    names = [o.name for o in session.get_outputs()]
    name = prefer if prefer in names else names[0]
    out = session.run([name], {k: v for k, v in feeds.items() if k in _inputs(session)})[0]
    if out.ndim != 2:
        raise AnalysisError(
            "model-incompatible", f"expected pooled embeddings, got shape {out.shape}"
        )
    return out.astype(np.float32)


def _inputs(session) -> set[str]:
    return {i.name for i in session.get_inputs()}


def _normalise(v: np.ndarray) -> list[list[float]]:
    n = np.linalg.norm(v, axis=1, keepdims=True)
    v = v / np.where(n == 0, 1, n)
    return [[round(float(x), 5) for x in row] for row in v]


def preprocess(rgb: np.ndarray) -> np.ndarray:
    """CLIP preprocessing: shortest side to 224 (bicubic), centre crop, normalise, NCHW."""
    import cv2

    h, w = rgb.shape[:2]
    scale = SIZE / min(h, w)
    nh, nw = max(SIZE, round(h * scale)), max(SIZE, round(w * scale))
    img = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_CUBIC)
    top, left = (nh - SIZE) // 2, (nw - SIZE) // 2
    img = img[top : top + SIZE, left : left + SIZE].astype(np.float32) / 255.0
    img = (img - MEAN) / STD
    return img.transpose(2, 0, 1)[np.newaxis, ...]


def grab_frame(path: str, at: float, ffmpeg: str = "ffmpeg") -> np.ndarray:
    """One RGB frame at `at` seconds, scaled so the short side is 256."""
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-ss",
        f"{max(0.0, at):.3f}",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=-2:256:flags=area",
        "-pix_fmt",
        "rgb24",
        "-f",
        "image2pipe",
        "-c:v",
        "ppm",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise AnalysisError("ffmpeg-missing", f"FFmpeg not found: {ffmpeg}") from exc
    data = proc.stdout
    if proc.returncode != 0 or not data.startswith(b"P6"):
        raise AnalysisError("decode-failed", f"cannot read a frame at {at:.2f} s")
    # PPM header: P6\n<w> <h>\n<max>\n
    parts = data.split(b"\n", 3)
    w, h = (int(x) for x in parts[1].split())
    return np.frombuffer(parts[3][: w * h * 3], dtype=np.uint8).reshape(h, w, 3)


def embed_frames(params: dict[str, Any], progress: Progress) -> dict[str, Any]:
    d = _model_dir(params)
    session = _session(d / "vision.onnx")
    times = [float(t) for t in params["times"]]
    ffmpeg = params.get("ffmpeg") or "ffmpeg"
    rows = []
    for i, t in enumerate(times):
        pixels = preprocess(grab_frame(params["path"], t, ffmpeg))
        rows.append(_run(session, {"pixel_values": pixels}, "image_embeds")[0])
        progress((i + 1) / max(1, len(times)))
    vectors = _normalise(np.stack(rows)) if rows else []
    return {"dim": len(vectors[0]) if vectors else 0, "vectors": vectors}


def embed_texts(params: dict[str, Any], progress: Progress) -> dict[str, Any]:
    from tokenizers import Tokenizer

    d = _model_dir(params)
    session = _session(d / "text.onnx")
    tok = Tokenizer.from_file(str(d / "tokenizer.json"))
    tok.no_padding()
    tok.enable_truncation(MAX_TOKENS)
    texts = [str(t) for t in params["texts"]]
    rows = []
    for i, text in enumerate(texts):
        enc = tok.encode(text)
        ids = np.array([enc.ids], dtype=np.int64)
        mask = np.ones_like(ids)
        rows.append(_run(session, {"input_ids": ids, "attention_mask": mask}, "text_embeds")[0])
        progress((i + 1) / max(1, len(texts)))
    vectors = _normalise(np.stack(rows)) if rows else []
    return {"dim": len(vectors[0]) if vectors else 0, "vectors": vectors}
