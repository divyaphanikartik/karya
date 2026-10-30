"""Reading word packs: built-in seed packs, plus Claude-written packs generated once per
(language, grade), validated and cached so cost does not grow with the number of students."""
from __future__ import annotations

import json
import logging
import threading
import unicodedata

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError

from .claude import claude_configured, claude_json, enforce_rate_limit
from .config import settings
from .languages import LANGUAGE_NAMES, LEVELS, Language

logger = logging.getLogger("karya.content")
router = APIRouter(tags=["content"])
_PACK_LOCK = threading.Lock()

# Unicode block each language's reading items must use.
SCRIPT_RANGES = {"hi": (0x0900, 0x097F), "te": (0x0C00, 0x0C7F), "en": (0x0041, 0x007A)}
PACK_LIMITS = {"letter": (8, 12, 4), "word": (8, 12, 16), "sentence": (4, 6, 60), "paragraph": (1, 2, 260)}
PACK_VERSION = 1

# Built-in draft packs. They are also bundled in the mobile app so a teacher can assess on the
# first day without any internet. A fluent early-literacy reviewer must check them before use.
SEED_PACKS: dict[str, dict[str, list[str]]] = {
    "en": {
        "letter": ["a", "m", "s", "t", "p", "b", "r", "d", "n", "c"],
        "word": ["cat", "sun", "pen", "bus", "ship", "fish", "tree", "book", "milk", "hand"],
        "sentence": ["I have a red ball.", "The cat is on the mat.", "We go to school.", "The sun is hot."],
        "paragraph": ["Ravi has a dog. The dog is brown. Ravi gives the dog milk every day. The dog likes to play with Ravi."],
    },
    "hi": {
        "letter": ["क", "म", "स", "र", "ल", "न", "ब", "प", "ग", "त"],
        "word": ["घर", "कमल", "नल", "जल", "बस", "फल", "आम", "मोर", "पानी", "किताब"],
        "sentence": ["राम घर जा रहा है।", "यह मेरा बस्ता है।", "बिल्ली दूध पीती है।", "आसमान नीला है।"],
        "paragraph": ["मीना के पास एक गाय है। गाय का रंग सफ़ेद है। मीना रोज़ गाय को घास खिलाती है। गाय मीना को दूध देती है।"],
    },
    "te": {
        "letter": ["అ", "క", "మ", "ర", "ల", "న", "ప", "స", "త", "గ"],
        "word": ["అమ్మ", "పాలు", "బడి", "కలం", "నీరు", "పండు", "ఆవు", "చేప", "ఇల్లు", "కిటికీ"],
        "sentence": ["ఇది నా పుస్తకం.", "అమ్మ అన్నం వండింది.", "పిల్లి పాలు తాగింది.", "ఆకాశం నీలంగా ఉంది."],
        "paragraph": ["రాము దగ్గర ఒక ఆవు ఉంది. ఆవు తెల్లగా ఉంది. రాము రోజూ ఆవుకు గడ్డి పెడతాడు. ఆవు రాముకు పాలు ఇస్తుంది."],
    },
}

class ContentLevels(BaseModel):
    letter: list[str]
    word: list[str]
    sentence: list[str]
    paragraph: list[str]


def _in_script(text: str, language: str) -> bool:
    lo, hi = SCRIPT_RANGES[language]
    letters = [ch for ch in text if unicodedata.category(ch)[0] in ("L", "M")]
    return bool(letters) and all(lo <= ord(ch) <= hi for ch in letters)


def validate_levels(levels: ContentLevels, language: str) -> list[str]:
    """Return problems with a generated pack; an empty list means it is safe to cache."""
    problems = []
    for level in LEVELS:
        items = getattr(levels, level)
        min_n, max_n, max_len = PACK_LIMITS[level]
        if not (min_n <= len(items) <= max_n):
            problems.append(f"{level}: expected {min_n}-{max_n} items, got {len(items)}")
        if len(set(items)) != len(items):
            problems.append(f"{level}: duplicate items")
        for item in items:
            if not item.strip() or len(item) > max_len:
                problems.append(f"{level}: item length out of range")
            elif not _in_script(item, language):
                problems.append(f"{level}: item not in {LANGUAGE_NAMES[language]} script")
    return problems


def seed_pack(language: str, grade: int) -> dict:
    return {
        "pack_id": f"seed-{language}-v{PACK_VERSION}",
        "language": language,
        "grade": grade,
        "version": PACK_VERSION,
        "source": "seed",
        "reviewed": False,
        "levels": SEED_PACKS[language],
    }


def _pack_path(language: str, grade: int):
    return settings.pack_dir / f"{language}_g{grade}_v{PACK_VERSION}.json"


def _content_schema() -> dict:
    def arr(level: str) -> dict:
        # Structured outputs reject minItems/maxItems; validate_levels enforces counts afterwards.
        return {"type": "array", "items": {"type": "string", "maxLength": PACK_LIMITS[level][2]}}

    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {level: arr(level) for level in LEVELS},
        "required": list(LEVELS),
    }


async def _generate_pack(language: str, grade: int) -> ContentLevels:
    name = LANGUAGE_NAMES[language]
    system = (
        f"You write early-reading assessment items in {name} for children in rural Indian government schools. "
        "Use very common, concrete, culturally familiar vocabulary (home, farm, food, animals, family, school). "
        f"Write only in the native {name} script; no transliteration, no English words in Hindi or Telugu items. "
        "letter: single basic letters (no conjuncts). word: 2-4 letter common words. "
        "sentence: simple 3-6 word sentences, one per item. paragraph: 4 short connected sentences "
        "at Grade 1-2 reading level, about 25-35 words total. Avoid religious, political, violent or brand content."
    )
    user = (
        f"Create a reading-level assessment pack for a Grade {grade} child, level ladder letter -> word -> sentence -> paragraph. "
        "Return exactly 10 letters, 10 words, 5 sentences and 2 paragraphs."
    )
    data = await claude_json(system, user, _content_schema(), 4000)
    # Keep extras out rather than reject an otherwise valid pack; too few items still fails validation.
    trimmed = {level: list(dict.fromkeys(data.get(level, [])))[: PACK_LIMITS[level][1]] for level in LEVELS}
    return ContentLevels.model_validate(trimmed)


@router.get("/content-pack")
async def content_pack(request: Request, language: Language = "hi", grade: int = 2):
    """Return a cached Claude-generated pack, generating it once if Claude is configured.

    Falls back to the seed pack offline, in demo mode, or when generation fails validation.
    """
    if not 1 <= grade <= 5:
        raise HTTPException(status_code=422, detail="grade must be between 1 and 5")
    path = _pack_path(language, grade)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if not claude_configured():
        return seed_pack(language, grade)
    enforce_rate_limit(request)
    try:
        levels = await _generate_pack(language, grade)
        problems = validate_levels(levels, language)
        if problems:
            logger.warning("Generated %s pack rejected: %s", language, problems[:5])
            return seed_pack(language, grade)
    except (httpx.HTTPError, ValueError, ValidationError) as exc:
        logger.warning("Content pack generation failed: %s", type(exc).__name__)
        return seed_pack(language, grade)
    pack = {
        "pack_id": f"claude-{language}-g{grade}-v{PACK_VERSION}",
        "language": language,
        "grade": grade,
        "version": PACK_VERSION,
        "source": "claude",
        "reviewed": False,
        "levels": levels.model_dump(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with _PACK_LOCK:
        path.write_text(json.dumps(pack, ensure_ascii=False, indent=1), encoding="utf-8")
    return pack
