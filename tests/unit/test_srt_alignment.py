import json
import pytest
from agent.services.srt_alignment import prepare, compile_plan


def source(**overrides):
    data = {"language": "ja", "audio_duration_seconds": 8, "segments": [
        {"text": "年金。", "words": [{"word": "年金", "start": 0.5, "end": 2}]},
        {"text": "確認する。", "words": [{"word": "確認する", "start": 4, "end": 7}]},
    ]}
    data.update(overrides)
    return prepare(json.dumps(data, ensure_ascii=False).encode())


def answer(plan, ends):
    return json.dumps(dict(schema_version=1, source_sha256=plan["source_sha256"], scene_end_unit_ids=ends))


def test_japanese_roundtrip_uses_one_alignment_and_continuous_timing():
    plan = source(word_segments=[{"word": "duplicate", "start": 0, "end": 1}])
    assert len(plan["units"]) == 2
    text, report = compile_plan(plan, answer(plan, [1, 2]))
    assert text == "1\n00:00:00,000 --> 00:00:04,000\n年金。\n\n2\n00:00:04,000 --> 00:00:08,000\n確認する。\n"
    assert report["text_preserved"] and report["coverage_percent"] == 100
    assert any(i["code"] == "DUPLICATE_ALIGNMENT_IGNORED" for i in report["issues"])


@pytest.mark.parametrize("ends", [[], [1], [2, 1], [1, 1, 2], [True, 2], [3]])
def test_invalid_boundaries_rejected(ends):
    plan = source()
    with pytest.raises(ValueError):
        compile_plan(plan, answer(plan, ends))


def test_snapshot_hash_must_match():
    plan = source()
    reply = json.loads(answer(plan, [2]))
    reply["source_sha256"] = "wrong"
    with pytest.raises(ValueError, match="snapshot"):
        compile_plan(plan, json.dumps(reply))


def test_missing_alignment_text_is_retained_and_reported():
    plan = source(segments=[{"text": "年金を確認。", "words": [{"word": "年金", "start": 0, "end": 1}]}])
    assert "".join(u["text"] for u in plan["units"]) == "年金を確認。"
    assert plan["report"]["missing_timing_units"] == 1
    text, _ = compile_plan(plan, answer(plan, [2]))
    assert "年金を確認。" in text
    with pytest.raises(ValueError, match="timing"):
        compile_plan(plan, answer(plan, [1, 2]))


def test_mismatched_word_blocks_generation():
    plan = source(segments=[{"text": "年金", "words": [{"word": "税金", "start": 0, "end": 1}]}])
    assert plan["report"]["status"] == "BLOCKED"
    with pytest.raises(ValueError, match="source transcript errors"):
        compile_plan(plan, answer(plan, [len(plan["units"])]))


def test_explicit_milliseconds_and_unknown_audio_tail():
    plan = prepare(json.dumps({"time_unit": "ms", "segments": [{"text": "你好。", "start": 500, "end": 2500}]}).encode())
    text, report = compile_plan(plan, answer(plan, [1]))
    assert "00:00:02,500" in text
    assert report["full_audio_duration_known"] is False
    assert report["duration_exception_count"] == 1


def test_overlapping_alignment_cannot_start_scene():
    plan = source(segments=[{"text": "ab", "words": [{"word": "a", "start": 0, "end": 5}, {"word": "b", "start": 4, "end": 6}]}])
    with pytest.raises(ValueError, match="overlapping"):
        compile_plan(plan, answer(plan, [1, 2]))


@pytest.mark.parametrize("value", [-1, float("nan"), float("inf"), True])
def test_invalid_source_timestamps(value):
    with pytest.raises(ValueError, match="Timestamps"):
        source(segments=[{"text": "hello", "start": value, "end": 2}])
