"""Read the compiler's golden NLE handoff files back with OpenTimelineIO and an XML parser."""

import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path

import opentimelineio as otio

GOLDEN = Path(__file__).resolve().parents[3] / "packages" / "compile" / "src" / "__golden__"


def test_otio_reads_back_with_the_same_cuts():
    tl = otio.adapters.read_from_file(str(GOLDEN / "handoff.otio"))
    tracks = list(tl.tracks)
    assert [t.kind for t in tracks] == ["Video", "Video", "Video", "Audio"]
    picture = tracks[0]
    clips = [c for c in picture if isinstance(c, otio.schema.Clip)]
    assert [c.name for c in clips] == ["forest.mp4", "Boss Fight.mp4", "Missing: Ending shot"]
    assert [c.source_range.duration.value for c in clips] == [48, 36, 24]
    assert clips[0].source_range.start_time.value == 300
    assert clips[0].media_reference.target_url == "file:///media/forest.mp4"
    assert isinstance(clips[2].media_reference, otio.schema.MissingReference)
    transitions = [c for c in picture if isinstance(c, otio.schema.Transition)]
    assert len(transitions) == 1
    assert transitions[0].in_offset.value + transitions[0].out_offset.value == 12
    # Positions on the track: the cut sits where the timeline has it.
    assert picture.range_of_child(clips[1]).start_time.value == 48
    assert tl.duration().value == 156
    assert [m.name for m in picture.markers] == ["section: Reveal"]
    # The document survives a write and a second read unchanged.
    again = otio.adapters.read_from_string(
        otio.adapters.write_to_string(tl, "otio_json"), "otio_json"
    )
    assert again.duration() == tl.duration()


def _t(value: str) -> Fraction:
    return Fraction(value[:-1]) if value != "0s" else Fraction(0)


def test_fcpxml_is_well_formed_and_the_spine_adds_up():
    root = ET.parse(GOLDEN / "handoff.fcpxml").getroot()
    assert root.tag == "fcpxml" and root.get("version") == "1.10"
    ids = {a.get("id") for a in root.iter("asset")} | {f.get("id") for f in root.iter("format")}
    for clip in root.iter("asset-clip"):
        assert clip.get("ref") in ids
    seq = root.find("library/event/project/sequence")
    spine = seq.find("spine")
    elements = [e for e in spine if e.tag in ("asset-clip", "gap")]
    end = Fraction(0)
    for e in elements:
        assert _t(e.get("offset")) == end, e.get("name")
        end += _t(e.get("duration"))
    assert end == _t(seq.get("duration")) == Fraction(156, 24)
    frame = Fraction(1, 24)
    for e in root.iter():
        for attr in ("offset", "duration", "start"):
            if e.get(attr) and e.tag != "asset":
                assert (_t(e.get(attr)) / frame).denominator == 1, (e.tag, attr, e.get(attr))
    urls = sorted(m.get("src") for m in root.iter("media-rep"))
    assert "file:///C:/Users/Dev/Boss%20Fight.mp4" in urls


def test_edl_events_are_exact():
    lines = (GOLDEN / "handoff.edl").read_text(encoding="ascii").splitlines()
    events = [line.split() for line in lines if line[:3].isdigit()]
    assert [e[0] for e in events] == ["001", "002", "003"]
    assert events[1][-2:] == ["00:00:02:00", "00:00:03:12"]
    assert events[2][1] == "BL"
