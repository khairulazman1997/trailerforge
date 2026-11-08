"""Reference-clip measurements (M10 10.4d): deterministic facts on a synthetic clip."""

import subprocess

import pytest

from tforge_analysis.reference import analyze_reference


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    out = tmp_path_factory.mktemp("ref") / "ref.mp4"
    graph = (
        "color=c=0xff7a1a:s=320x180:r=30:d=4[bg];color=c=white:s=40x40:r=30:d=4[box];"
        "[bg][box]overlay=x='40+t*60':y=70,fade=t=in:st=0:d=1,"
        "drawbox=enable='between(t,2,2.05)':x=0:y=0:w=iw:h=ih:color=white:t=fill"
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-filter_complex", graph, "-c:v", "libx264",
         "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-threads", "1", str(out)],
        check=True,
    )  # fmt: skip
    return str(out)


def test_reference_facts(clip):
    r = analyze_reference({"path": clip, "duration": 4}, lambda _f: None)
    assert r["seconds"] == 4.0
    assert r["colors"][0]["hex"] in ("#ff7711", "#ff7722", "#ee7711", "#ff8822")
    kinds = [e["kind"] for e in r["events"]]
    assert "fade-in" in kinds
    fade = next(e for e in r["events"] if e["kind"] == "fade-in")
    assert fade["from"] == 0.0 and 0.6 <= fade["to"] <= 1.1
    flash = [e for e in r["events"] if e["kind"] == "flash"]
    assert len(flash) == 1 and abs(flash[0]["at"] - 2.0) <= 0.07
    assert r["motion"]["direction"] == "right"
    assert 0.12 <= r["motion"]["speed"] <= 0.3


def test_reference_is_deterministic(clip):
    a = analyze_reference({"path": clip}, lambda _f: None)
    b = analyze_reference({"path": clip}, lambda _f: None)
    assert a == b
