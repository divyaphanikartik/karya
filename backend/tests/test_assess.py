from app import assess


def attempt(**overrides):
    base = {
        "attempt_id": "att-1", "language": "hi", "level": "sentence", "grade": 2,
        "expected_items": ["राम घर जा रहा है।"], "teacher_marks": [True, True, False, True, True], "duration_sec": 6,
    }
    base.update(overrides)
    return base


def test_tokenize_strips_danda_and_punctuation():
    assert assess.tokenize("राम घर जा रहा है।") == ["राम", "घर", "जा", "रहा", "है"]
    assert assess.tokenize("ఇది నా పుస్తకం.") == ["ఇది", "నా", "పుస్తకం"]
    assert assess.tokenize("The cat, is on the mat!") == ["the", "cat", "is", "on", "the", "mat"]


def test_alignment_ops():
    ops = assess.align(["the", "cat", "is", "on", "mat"], ["the", "bat", "is", "mat", "now"])
    assert [o["op"] for o in ops] == ["correct", "substitution", "correct", "omission", "correct", "insertion"]
    assert assess.asr_word_marks(["the", "cat", "is", "on", "mat"], ops) == [True, False, True, False, True]


def test_without_transcript_uses_rules(client):
    body = client.post("/api/assess-reading", json=attempt()).json()
    assert body["transcript"] is None
    assert body["feedback_source"] == "rules"
    assert body["feedback"]["agreement"] == "no_transcript"
    assert body["teacher_accuracy"] == 0.8
    assert body["words_correct_per_minute"] == 40.0


def test_rule_note_uses_app_language(client):
    hi = client.post("/api/assess-reading", json=attempt(note_language="hi")).json()["feedback"]
    assert hi["note_for_teacher"].startswith("5 में से 1 शब्द") and "जा" in hi["note_for_teacher"]
    te = client.post("/api/assess-reading", json=attempt(note_language="te")).json()["feedback"]
    assert te["practice_suggestion"].startswith("తప్పుగా")
    # Older apps that don't send it still get English.
    assert client.post("/api/assess-reading", json=attempt()).json()["feedback"]["note_for_teacher"].startswith("Teacher marked")


def test_rejects_mark_count_mismatch(client):
    assert client.post("/api/assess-reading", json=attempt(teacher_marks=[True])).status_code == 422


def test_with_on_device_transcript(client):
    body = client.post("/api/assess-reading", json=attempt(asr_transcript="राम घर गया रहा है", asr_model="indicconformer-hi")).json()
    assert body["transcript"] == "राम घर गया रहा है"
    assert body["asr_model"] == "indicconformer-hi"
    assert body["asr_accuracy"] == 0.8
    assert body["feedback"]["agreement"] == "agrees"  # speech model also flagged "जा"
    assert "word_substituted" in body["feedback"]["error_patterns"]


def test_teacher_and_speech_model_partly_agree(client):
    body = client.post("/api/assess-reading", json=attempt(teacher_marks=[True] * 5, asr_transcript="राम घर गया रहा है")).json()
    assert body["feedback"]["agreement"] == "partly_agrees"  # 4 of 5 words match


def test_blank_transcript_counts_as_none(client):
    assert client.post("/api/assess-reading", json=attempt(asr_transcript="   ")).json()["transcript"] is None


def test_endpoint_takes_no_audio(client):
    """Audio never leaves the phone: the endpoint is JSON-only."""
    r = client.post("/api/assess-reading", data={"meta": "{}"}, files={"audio": ("a.m4a", b"x", "audio/mp4")})
    assert r.status_code == 422


def test_claude_failure_falls_back_to_rules(client, with_claude_key, monkeypatch):
    async def broken(*args):
        raise ValueError("bad json")

    monkeypatch.setattr(assess, "claude_feedback", broken)
    assert client.post("/api/assess-reading", json=attempt()).json()["feedback_source"] == "rule_fallback"


def test_story_level_reports_reading_speed(client):
    body = client.post("/api/assess-reading", json=attempt(level="story", grade=4, duration_sec=5)).json()
    assert body["words_correct_per_minute"] == 48.0
