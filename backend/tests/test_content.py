import json
import re
from pathlib import Path

import pytest

from app import content

MOBILE_SEED = Path(__file__).resolve().parents[2] / "mobile" / "src" / "lib" / "seedPacks.json"


@pytest.mark.parametrize("language", ["en", "hi", "te"])
def test_seed_packs_pass_validation(language):
    levels = content.ContentLevels.model_validate(content.SEED_PACKS[language])
    assert content.validate_levels(levels, language) == []


def test_mobile_bundled_seed_packs_match_server():
    """The phone ships the same seed packs so a first-day assessment works with no internet."""
    bundled = json.loads(MOBILE_SEED.read_text(encoding="utf-8"))
    assert {lang: pack["levels"] for lang, pack in bundled.items()} == content.SEED_PACKS


def test_demo_mode_returns_seed(client):
    r = client.get("/api/content-pack?language=te&grade=2")
    assert r.status_code == 200
    assert r.json()["source"] == "seed"
    assert r.json()["levels"]["word"][0] == "పాలు"


def test_grade_out_of_range(client):
    assert client.get("/api/content-pack?language=hi&grade=9").status_code == 422


def test_validation_rejects_wrong_script():
    levels = content.ContentLevels.model_validate({**content.SEED_PACKS["hi"], "word": content.SEED_PACKS["te"]["word"]})
    assert any("script" in p for p in content.validate_levels(levels, "hi"))


def test_generated_pack_is_cached_once(client, with_claude_key, monkeypatch):
    calls = []

    async def fake_generate(language, grade, **_):
        calls.append(language)
        return content.ContentLevels.model_validate(content.SEED_PACKS[language])

    monkeypatch.setattr(content, "_generate_pack", fake_generate)
    first = client.get("/api/content-pack?language=en&grade=3").json()
    second = client.get("/api/content-pack?language=en&grade=3").json()
    assert first["source"] == second["source"] == "claude"
    assert calls == ["en"]


def test_invalid_generated_pack_falls_back_to_seed(client, with_claude_key, monkeypatch):
    async def fake_generate(language, grade, **_):
        return content.ContentLevels(capital=["A"], letter=["a"], word=["cat"], sentence=["Hi."])

    monkeypatch.setattr(content, "_generate_pack", fake_generate)
    assert client.get("/api/content-pack?language=en&grade=2").json()["source"] == "seed"


def test_english_follows_the_aser_english_ladder(client):
    levels = client.get("/api/content-pack?language=en&grade=3").json()["levels"]
    assert list(levels) == ["capital", "letter", "word", "sentence"]
    hindi = client.get("/api/content-pack?language=hi&grade=3").json()["levels"]
    assert list(hindi) == ["letter", "word", "paragraph", "story"]


def test_english_seed_has_meaning_hints_for_every_word_and_sentence():
    pack = content.seed_pack("en", 3)
    items = pack["levels"]["word"] + pack["levels"]["sentence"]
    assert len(pack["levels"]["sentence"]) >= 8  # 4 per attempt, fresh ones on a retry
    for lang in content.HINT_LANGUAGES:
        assert set(pack["meanings"][lang]) == set(items)
    assert "meanings" not in content.seed_pack("hi", 3)


def test_mobile_bundled_meanings_match_server():
    bundled = json.loads(MOBILE_SEED.read_text(encoding="utf-8"))
    assert bundled["en"]["meanings"] == content.SEED_MEANINGS


def test_clean_meanings_drops_wrong_script_and_unknown_items():
    levels = content.ContentLevels.model_validate({
        **content.SEED_PACKS["en"],
        "meanings": {"hi": {"cat": "बिल्ली", "dog": "कुत्ता", "sun": "sun"}, "te": {"cat": "పిల్లి"}},
    })
    assert content.clean_meanings(levels) == {"hi": {"cat": "बिल्ली"}, "te": {"cat": "పిల్లి"}}


def test_generated_english_pack_keeps_clean_meanings(client, with_claude_key, monkeypatch):
    async def fake_generate(language, grade, **_):
        return content.ContentLevels.model_validate({**content.SEED_PACKS[language], "meanings": content.SEED_MEANINGS})

    monkeypatch.setattr(content, "_generate_pack", fake_generate)
    pack = client.get("/api/content-pack?language=en&grade=4").json()
    assert pack["source"] == "claude"
    assert pack["meanings"]["te"]["Can you see a cat?"] == "నీకు పిల్లి కనిపిస్తోందా?"


@pytest.mark.parametrize("language", ["hi", "te"])
def test_state_language_seed_follows_aser_reading_tool(language):
    levels = content.SEED_PACKS[language]
    assert "sentence" not in levels
    assert len(levels["paragraph"]) >= 2  # ASER lets the child choose between 2 paragraphs
    for paragraph in levels["paragraph"]:
        sentences = _sentences(paragraph)
        assert len(sentences) == 4 and all(len(s.split()) <= 6 for s in sentences)
    assert 7 <= len(_sentences(levels["story"][0])) <= 10


def _sentences(text):
    """Split on sentence-ending marks; keep pieces with letters (a closing quote alone is not a sentence)."""
    return [s for s in re.split(r"[।.!?]", text) if any(ch.isalpha() for ch in s)]


@pytest.mark.parametrize("language", ["en", "hi", "te"])
def test_seed_text_uses_natural_punctuation(language):
    """Not only full stops: some questions, commas or exclamations, as in a textbook."""
    levels = content.SEED_PACKS[language]
    text = " ".join(levels.get("sentence", []) + levels.get("paragraph", []) + levels.get("story", []))
    assert "?" in text and "," in text and "!" in text


@pytest.mark.parametrize("language", ["en", "hi", "te"])
def test_practice_pool_meets_the_same_standards_with_different_items(language):
    practice = content.ContentLevels.model_validate(content.SEED_PRACTICE[language])
    assert content.validate_levels(practice, language) == []
    for level, items in content.SEED_PRACTICE[language].items():
        assert not set(items) & set(content.SEED_PACKS[language][level]), f"{level} repeats a check item"
    if language != "en":
        for paragraph in content.SEED_PRACTICE[language]["paragraph"]:
            sentences = _sentences(paragraph)
            assert len(sentences) == 4 and all(len(s.split()) <= 6 for s in sentences)
        assert 7 <= len(_sentences(content.SEED_PRACTICE[language]["story"][0])) <= 10


def test_mobile_bundles_the_practice_pool():
    bundled = json.loads(MOBILE_SEED.read_text(encoding="utf-8"))
    assert {lang: pack["practice"] for lang, pack in bundled.items()} == content.SEED_PRACTICE


def test_practice_pack_endpoint(client):
    pack = client.get("/api/content-pack?language=hi&grade=2&kind=practice").json()
    assert pack["kind"] == "practice" and pack["levels"]["word"][0] == "दाल"


def test_generated_practice_drops_items_from_the_check(client, with_claude_key, monkeypatch):
    seen = {}

    async def fake_generate(language, grade, kind="check", avoid=frozenset()):
        seen["avoid"] = avoid
        return content.ContentLevels.model_validate(content.SEED_PRACTICE[language])

    monkeypatch.setattr(content, "_generate_pack", fake_generate)
    pack = client.get("/api/content-pack?language=te&grade=3&kind=practice").json()
    assert pack["source"] == "claude" and pack["kind"] == "practice"
    assert "పాలు" in seen["avoid"]  # the check's words were passed in to be avoided
