import numpy as np
import pytest
from synth import write_video
from tiny_model import DIM, build, build_combined

from tforge_analysis.rpc import AnalysisError
from tforge_analysis.vision import embed_frames, embed_texts, preprocess


def quiet(_f):
    pass


@pytest.fixture(scope="module")
def model(tmp_path_factory):
    return build(tmp_path_factory.mktemp("model"))


@pytest.fixture(scope="module")
def red_then_blue(tmp_path_factory):
    red = [np.dstack([np.full((180, 320), 220), np.full((180, 320), 20), np.full((180, 320), 20)])]
    blue = [np.dstack([np.full((180, 320), 20), np.full((180, 320), 20), np.full((180, 320), 220)])]
    frames = red * 30 + blue * 30
    return write_video(
        [f.astype(np.uint8) for f in frames], tmp_path_factory.mktemp("v") / "rb.mp4"
    )


def test_frames_embed_to_unit_vectors_that_tell_pictures_apart(model, red_then_blue):
    seen = []
    r = embed_frames(
        {"modelDir": str(model), "path": str(red_then_blue), "times": [0.5, 0.6, 1.5]}, seen.append
    )
    assert r["dim"] == DIM and len(r["vectors"]) == 3
    a, a2, b = (np.array(v) for v in r["vectors"])
    assert abs(np.linalg.norm(a) - 1) < 1e-4
    assert a @ a2 > 0.9999  # same picture
    assert a @ b < 0.99  # different picture
    assert seen[-1] == 1.0


def test_texts_embed_deterministically(model):
    p = {"modelDir": str(model), "texts": ["a red boss", "a blue forest", "a red boss"]}
    r = embed_texts(p, quiet)
    x, y, z = (np.array(v) for v in r["vectors"])
    assert x.tolist() == z.tolist() and x @ y < 0.999
    assert embed_texts(p, quiet) == r


def test_preprocess_matches_clip_shape_and_range():
    out = preprocess(np.zeros((180, 320, 3), np.uint8))
    assert out.shape == (1, 3, 224, 224)
    assert np.allclose(out[0, 0], -0.48145466 / 0.26862954, atol=1e-5)


def test_missing_and_incompatible_models_fail_with_codes(tmp_path, model):
    with pytest.raises(AnalysisError) as e:
        embed_texts({"modelDir": str(tmp_path), "texts": ["a"]}, quiet)
    assert e.value.code == "model-missing"
    bad = build(tmp_path / "bad", pooled=False)
    with pytest.raises(AnalysisError) as e:
        embed_texts({"modelDir": str(bad), "texts": ["a red boss"]}, quiet)
    assert e.value.code == "model-incompatible"


def test_unreadable_video_fails_with_a_code(model, tmp_path):
    bad = tmp_path / "x.mp4"
    bad.write_text("nope")
    with pytest.raises(AnalysisError) as e:
        embed_frames({"modelDir": str(model), "path": str(bad), "times": [0]}, quiet)
    assert e.value.code == "decode-failed"


def test_a_combined_model_gives_the_same_kind_of_vectors(tmp_path, red_then_blue):
    d = build_combined(tmp_path / "combined")
    frames = embed_frames(
        {"modelDir": str(d), "path": str(red_then_blue), "times": [0.5, 1.5]}, quiet
    )
    a, b = (np.array(v) for v in frames["vectors"])
    assert frames["dim"] == DIM and a @ b < 0.99
    texts = embed_texts({"modelDir": str(d), "texts": ["a red boss", "a red boss"]}, quiet)
    assert texts["vectors"][0] == texts["vectors"][1]
