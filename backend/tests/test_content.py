import json
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
    assert r.json()["levels"]["word"][0] == "అమ్మ"


def test_grade_out_of_range(client):
    assert client.get("/api/content-pack?language=hi&grade=9").status_code == 422


def test_validation_rejects_wrong_script():
    levels = content.ContentLevels.model_validate({**content.SEED_PACKS["hi"], "word": content.SEED_PACKS["te"]["word"]})
    assert any("script" in p for p in content.validate_levels(levels, "hi"))


def test_generated_pack_is_cached_once(client, with_claude_key, monkeypatch):
    calls = []

    async def fake_generate(language, grade):
        calls.append(language)
        return content.ContentLevels.model_validate(content.SEED_PACKS[language])

    monkeypatch.setattr(content, "_generate_pack", fake_generate)
    first = client.get("/api/content-pack?language=en&grade=3").json()
    second = client.get("/api/content-pack?language=en&grade=3").json()
    assert first["source"] == second["source"] == "claude"
    assert calls == ["en"]


def test_invalid_generated_pack_falls_back_to_seed(client, with_claude_key, monkeypatch):
    async def fake_generate(language, grade):
        return content.ContentLevels(letter=["a"], word=["cat"], sentence=["Hi."], paragraph=["Hi."])

    monkeypatch.setattr(content, "_generate_pack", fake_generate)
    assert client.get("/api/content-pack?language=en&grade=2").json()["source"] == "seed"
