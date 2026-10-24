import io
import json

import numpy as np
import pytest
from synth import click_track, moving, solid, write_audio, write_video

from tforge_analysis.footage import analyze_footage
from tforge_analysis.music import analyze_music
from tforge_analysis.rpc import AnalysisError, RpcServer

FRAME = 1 / 30  # "within one frame" at 30 fps


def nearest(xs, t):
    return min(xs, key=lambda x: abs(x - t))


def no_progress(_f):
    pass


@pytest.fixture(scope="module")
def track120(tmp_path_factory):
    y, beats, downs = click_track(120, 16, loud_from_bar=8)
    return write_audio(y, tmp_path_factory.mktemp("m") / "t120.wav"), beats, downs


def test_beats_tempo_and_downbeats_on_a_click_track(track120):
    path, beats, downs = track120
    r = analyze_music({"path": str(path)}, no_progress)
    assert abs(r["tempo"] - 120) < 1
    # every beat found, including the quiet intro, and none invented in the silence around it
    assert len(r["beats"]) == len(beats)
    for b in beats:
        assert abs(nearest(r["beats"], b) - b) <= FRAME
    for d in r["downbeats"]:
        assert abs(nearest(downs, d) - d) <= FRAME  # every downbeat is a real bar start
    assert len(r["downbeats"]) >= 0.9 * len(downs)
    assert r["beatsPerBar"] == 4


def test_sections_follow_the_change_in_the_music(track120):
    path, _, downs = track120
    r = analyze_music({"path": str(path)}, no_progress)
    assert len(r["sections"]) == 2
    change = r["sections"][1]["start"]
    bar = downs[1] - downs[0]
    assert abs(change - downs[8]) <= bar + 0.01
    assert r["sections"][1]["energy"] > r["sections"][0]["energy"]
    assert r["energy"]["hop"] == 0.1 and max(r["energy"]["values"]) == 100


def test_other_tempo_and_a_compressed_container(tmp_path):
    y, beats, _ = click_track(90, 8, first_beat_s=1.0)
    r = analyze_music({"path": str(write_audio(y, tmp_path / "t90.m4a"))}, no_progress)
    assert abs(r["tempo"] - 90) < 1
    for b in beats[1:-1]:
        assert abs(nearest(r["beats"], b) - b) <= FRAME


def test_music_analysis_is_deterministic(track120):
    a = analyze_music({"path": str(track120[0])}, no_progress)
    b = analyze_music({"path": str(track120[0])}, no_progress)
    assert a == b


def test_silent_short_and_unreadable_tracks_fail_with_codes(tmp_path):
    with pytest.raises(AnalysisError) as e:
        analyze_music(
            {"path": str(write_audio(np.zeros(44100 * 3, np.float32), tmp_path / "s.wav"))},
            no_progress,
        )
    assert e.value.code == "silent"
    with pytest.raises(AnalysisError) as e:
        analyze_music(
            {"path": str(write_audio(np.zeros(2000, np.float32), tmp_path / "x.wav"))}, no_progress
        )
    assert e.value.code == "too-short"
    bad = tmp_path / "bad.wav"
    bad.write_text("not audio")
    with pytest.raises(AnalysisError) as e:
        analyze_music({"path": str(bad)}, no_progress)
    assert e.value.code == "decode-failed"


@pytest.fixture(scope="module")
def footage(tmp_path_factory):
    # 0-29 scene A (moving) | 30-44 black | 45 white flash | 46-75 scene B (moving)
    # | 76-105 frozen on B's last frame | 106-135 scene C (moving)
    b = moving("bars", 30)
    frames = (
        moving("checker", 30)
        + solid(16, 15)
        + solid(250, 1)
        + b
        + [b[-1]] * 30
        + moving("checker", 30, start=500)
    )
    return write_video(frames, tmp_path_factory.mktemp("f") / "f.mp4")


def test_footage_ground_truth(footage):
    seen = []
    r = analyze_footage(
        {"path": str(footage), "rate": {"num": 30, "den": 1}, "duration": 4.53}, seen.append
    )
    assert r["frameCount"] == 136
    assert r["rate"] == {"num": 30, "den": 1}
    assert [s for s, _ in r["black"]] == [30] and abs(r["black"][0][1] - 45) <= 1
    assert r["flashes"] == [45]
    assert len(r["frozen"]) == 1
    start, end = r["frozen"][0]
    assert abs(start - 75) <= 1 and abs(end - 106) <= 1
    for cut in (30, 106):
        assert any(abs(s - cut) <= 1 for s in r["scenes"]), r["scenes"]
    assert any(s in (45, 46) for s in r["scenes"])
    assert all(any(abs(s - c) <= 1 for c in (30, 45, 46, 106)) for s in r["scenes"])
    assert len(r["brightness"]) == len(r["motion"]) == 136
    assert r["motion"][0] == 0 and min(r["motion"][80:100]) == max(r["motion"][80:100]) == 0
    assert seen and seen[-1] == 1.0


def test_footage_is_deterministic(footage):
    p = {"path": str(footage), "rate": {"num": 30, "den": 1}, "duration": 4.53}
    assert analyze_footage(p, no_progress) == analyze_footage(p, no_progress)


def test_audio_only_file_has_no_video(tmp_path):
    y, _, _ = click_track(120, 2)
    with pytest.raises(AnalysisError) as e:
        analyze_footage(
            {"path": str(write_audio(y, tmp_path / "a.wav")), "rate": {"num": 30, "den": 1}},
            no_progress,
        )
    assert e.value.code in ("no-video", "decode-failed")


def test_progress_notifications_and_error_codes_over_rpc():
    server = RpcServer()

    def work(_params, progress):
        for f in (0.25, 0.5, 1.0):
            progress(f)
        return {"ok": True}

    def fail(_params, _progress):
        raise AnalysisError("no-video", "nothing to see")

    server.register("work", work, progress=True)
    server.register("fail", fail, progress=True)
    out = io.StringIO()
    server.serve(
        io.StringIO(
            '{"jsonrpc":"2.0","id":7,"method":"work"}\n{"jsonrpc":"2.0","id":8,"method":"fail"}\n'
        ),
        out,
    )
    lines = [json.loads(x) for x in out.getvalue().splitlines()]
    notes = [x for x in lines if x.get("method") == "progress"]
    assert [n["params"] for n in notes] == [{"id": 7, "fraction": f} for f in (0.25, 0.5, 1.0)]
    assert {"id": 7, "result": {"ok": True}, "jsonrpc": "2.0"} in lines
    err = next(x for x in lines if x.get("id") == 8)
    assert err["error"]["code"] == -32000 and err["error"]["data"] == {"code": "no-video"}
