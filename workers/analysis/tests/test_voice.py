from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from tforge_analysis.rpc import AnalysisError
from tforge_analysis.voice import MODEL_FILES, envelope, envelope_db, transcribe

SR = 16_000


def quiet(_f):
    pass


@pytest.fixture(scope="module")
def speechlike(tmp_path_factory):
    """0.5 s silence, 1 s tone, 0.5 s silence, 0.8 s tone, 0.2 s silence (stands in for words)."""
    t = lambda s: np.arange(int(s * SR)) / SR
    parts = [
        np.zeros(int(0.5 * SR)),
        0.3 * np.sin(2 * np.pi * 220 * t(1.0)),
        np.zeros(int(0.5 * SR)),
        0.3 * np.sin(2 * np.pi * 330 * t(0.8)),
        np.zeros(int(0.2 * SR)),
    ]
    path = tmp_path_factory.mktemp("vo") / "vo.wav"
    sf.write(path, np.concatenate(parts).astype(np.float32), SR)
    return path


def test_envelope_marks_sound_and_silence_every_10_ms(speechlike):
    seen = []
    r = envelope({"path": str(speechlike)}, seen.append)
    db = r["envelope"]["db"]
    assert r["envelope"]["hop"] == 0.01
    assert abs(r["duration"] - 3.0) < 0.01
    assert len(db) == 300
    loud = [i for i, v in enumerate(db) if v > -30]
    # The tones are at 0.5–1.5 s and 2.0–2.8 s.
    assert loud[0] == 50 and loud[-1] == 279
    assert all(v > -30 for v in db[50:150]) and all(v < -60 for v in db[155:195])
    assert seen and seen[-1] <= 1


def test_envelope_db_is_floored_and_rounded():
    assert envelope_db(np.zeros(320, dtype=np.float32)) == [-90.0, -90.0]
    full = envelope_db(np.ones(160, dtype=np.float32))
    assert full == [0.0]
    assert envelope_db(np.zeros(0, dtype=np.float32)) == []


class FakeModel:
    """Stands in for faster-whisper: two segments with word timings."""

    def __init__(self):
        self.kwargs = None

    def transcribe(self, audio, **kwargs):
        self.kwargs = kwargs
        self.samples = len(audio)
        w = lambda s, e, text, p=0.9: SimpleNamespace(start=s, end=e, word=text, probability=p)
        segs = [
            SimpleNamespace(
                start=0.5,
                end=1.5,
                text=" This boss has",
                words=[w(0.52, 0.8, " This"), w(0.8, 1.1, " boss"), w(1.1, 1.48, " has")],
            ),
            SimpleNamespace(
                start=2.0,
                end=2.8,
                text=" one tell.",
                words=[w(2.0, 2.3, " one"), w(2.3, 2.79, " tell."), w(2.79, 2.79, " ")],
            ),
        ]
        return iter(segs), SimpleNamespace(language="en", language_probability=0.98765)


def model_dir(tmp_path):
    for f in MODEL_FILES:
        (tmp_path / f).write_text("x")
    return tmp_path


def test_transcribe_returns_words_segments_language_and_the_envelope(speechlike, tmp_path):
    fake = FakeModel()
    seen = []
    r = transcribe(
        {
            "path": str(speechlike),
            "modelDir": str(model_dir(tmp_path)),
            "language": "en",
            "prompt": "Ember Knight",
        },
        seen.append,
        load=lambda _d: fake,
    )
    assert r["language"] == "en" and r["languageProbability"] == 0.988
    assert [w["text"] for w in r["words"]] == ["This", "boss", "has", "one", "tell."]
    assert r["words"][0] == {"start": 0.52, "end": 0.8, "text": "This", "p": 0.9}
    assert r["segments"][1] == {"start": 2.0, "end": 2.8, "text": "one tell."}
    assert len(r["envelope"]["db"]) == 300
    # Deterministic decoding, word timings on, the script as a hint, 16 kHz mono in.
    k = fake.kwargs
    assert k["temperature"] == 0.0 and k["beam_size"] == 1 and k["word_timestamps"] is True
    assert k["condition_on_previous_text"] is False and k["language"] == "en"
    assert k["initial_prompt"] == "Ember Knight"
    assert fake.samples == 3 * SR
    assert seen[-1] == pytest.approx(0.15 + 0.8 * 2.8 / 3)


def test_transcribe_refuses_a_missing_model(speechlike, tmp_path):
    (tmp_path / "config.json").write_text("{}")
    with pytest.raises(AnalysisError) as e:
        transcribe(
            {"path": str(speechlike), "modelDir": str(tmp_path)}, quiet, load=lambda _d: None
        )
    assert e.value.code == "model-missing"
    assert "model.bin" in str(e.value)
