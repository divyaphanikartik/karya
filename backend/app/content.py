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
from .languages import LADDERS, LANGUAGE_NAMES, Language

logger = logging.getLogger("karya.content")
router = APIRouter(tags=["content"])
_PACK_LOCK = threading.Lock()

# Unicode block each language's reading items must use.
SCRIPT_RANGES = {"hi": (0x0900, 0x097F), "te": (0x0C00, 0x0C7F), "en": (0x0041, 0x007A)}
PACK_LIMITS = {
    "capital": (8, 12, 1), "letter": (8, 12, 4), "word": (8, 12, 16), "sentence": (4, 6, 60), "paragraph": (1, 2, 260), "story": (1, 2, 700),
}
PACK_VERSION = 3  # v2 added the story level; v3 the English ladder (capital letters, no paragraph/story)

# Built-in draft packs. They are also bundled in the mobile app so a teacher can assess on the
# first day without any internet. A fluent early-literacy reviewer must check them before use.
SEED_PACKS: dict[str, dict[str, list[str]]] = {
    "en": {
        # English is a second language for most children here: common capitals and small letters,
        # regular 3-letter words (sounded out letter by letter), and short sentences built from them.
        "capital": ["A", "B", "C", "D", "M", "N", "P", "R", "S", "T"],
        "letter": ["a", "m", "s", "t", "p", "b", "r", "d", "n", "c"],
        "word": ["cat", "sun", "pen", "bus", "hen", "cup", "bag", "box", "red", "hat"],
        "sentence": ["I have a red bag.", "The sun is hot.", "This is my pen.", "The hen is big.", "I can run fast."],
    },
    "hi": {
        "letter": ["क", "म", "स", "र", "ल", "न", "ब", "प", "ग", "त"],
        "word": ["घर", "कमल", "नल", "जल", "बस", "फल", "आम", "मोर", "पानी", "किताब"],
        "sentence": ["राम घर जा रहा है।", "यह मेरा बस्ता है।", "बिल्ली दूध पीती है।", "आसमान नीला है।"],
        "paragraph": ["मीना के पास एक गाय है। गाय का रंग सफ़ेद है। मीना रोज़ गाय को घास खिलाती है। गाय मीना को दूध देती है।"],
        "story": [
            "सोनू का एक छोटा भाई है। उसका नाम मोनू है। एक दिन दोनों खेत में गए। वहाँ एक पेड़ पर आम लगे थे। "
            "मोनू आम तोड़ना चाहता था। पर पेड़ बहुत ऊँचा था। सोनू ने एक डंडे से दो आम गिराए। "
            "दोनों ने घर जाकर माँ के साथ आम खाए।"
        ],
    },
    "te": {
        "letter": ["అ", "క", "మ", "ర", "ల", "న", "ప", "స", "త", "గ"],
        "word": ["అమ్మ", "పాలు", "బడి", "కలం", "నీరు", "పండు", "ఆవు", "చేప", "ఇల్లు", "కిటికీ"],
        "sentence": ["ఇది నా పుస్తకం.", "అమ్మ అన్నం వండింది.", "పిల్లి పాలు తాగింది.", "ఆకాశం నీలంగా ఉంది."],
        "paragraph": ["రాము దగ్గర ఒక ఆవు ఉంది. ఆవు తెల్లగా ఉంది. రాము రోజూ ఆవుకు గడ్డి పెడతాడు. ఆవు రాముకు పాలు ఇస్తుంది."],
        "story": [
            "సీత ఒక చిన్న ఊరిలో ఉంటుంది. ఆమె దగ్గర ఒక కోడి ఉంది. ప్రతి రోజూ సీత కోడికి గింజలు వేస్తుంది. "
            "ఒక రోజు కోడి కనిపించలేదు. సీత ఇంటి వెనుక వెతికింది. కోడి గడ్డి కుప్ప దగ్గర కూర్చుంది. "
            "దాని కింద ఆరు గుడ్లు ఉన్నాయి. సీత సంతోషంగా అమ్మకు చెప్పింది."
        ],
    },
}

class ContentLevels(BaseModel):
    # Only the levels on the language's ladder are filled (see LADDERS).
    capital: list[str] = []
    letter: list[str] = []
    word: list[str] = []
    sentence: list[str] = []
    paragraph: list[str] = []
    story: list[str] = []

    def for_language(self, language: str) -> dict[str, list[str]]:
        return {level: getattr(self, level) for level in LADDERS[language]}


def _in_script(text: str, language: str) -> bool:
    lo, hi = SCRIPT_RANGES[language]
    letters = [ch for ch in text if unicodedata.category(ch)[0] in ("L", "M")]
    return bool(letters) and all(lo <= ord(ch) <= hi for ch in letters)


def validate_levels(levels: ContentLevels, language: str) -> list[str]:
    """Return problems with a generated pack; an empty list means it is safe to cache."""
    problems = []
    for level in LADDERS[language]:
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


def _content_schema(language: str) -> dict:
    def arr(level: str) -> dict:
        # Structured outputs reject minItems/maxItems; validate_levels enforces counts afterwards.
        return {"type": "array", "items": {"type": "string", "maxLength": PACK_LIMITS[level][2]}}

    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {level: arr(level) for level in LADDERS[language]},
        "required": list(LADDERS[language]),
    }


# What each level means. Each level is a fixed standard for every grade.
LEVEL_SPECS = {
    "state": (
        "letter: single common basic letters (no conjuncts). "
        "word: familiar words of 2-3 letters with at most 1-2 vowel signs (matras). "
        "sentence: simple sentences of 4-5 common words, one per item (the end-of-Grade-1 goal). "
        "paragraph (Std 1 text): 4 short linked sentences, each at most 6 words. "
        "story (Std 2 text): a short story of 7-10 simple sentences with straightforward construction, about 50-80 words."
    ),
    "en": (
        "English is a second language for these children: they learn to read first in their home or state language "
        "and hear little English outside school. capital: single common capital letters. letter: single common small "
        "letters. word: 3-letter, phonetically regular words a child can sound out (consonant-vowel-consonant), using "
        "only very common nouns, colours and actions. sentence: simple sentences of 4-5 words built mostly from such "
        "words and common sight words (I, a, the, is, my, can), one per item."
    ),
}
LEVEL_COUNTS = {"capital": 10, "letter": 10, "word": 10, "sentence": 5, "paragraph": 2, "story": 2}


async def _generate_pack(language: str, grade: int) -> ContentLevels:
    name = LANGUAGE_NAMES[language]
    system = (
        f"You write early-reading assessment items in {name} for children in government and low-income schools in "
        "rural India, where many children in Grades 1-3 are still learning letters and simple words. "
        "Use very common, concrete, culturally familiar vocabulary (home, farm, food, animals, family, school); avoid "
        "objects and experiences that rural children may not know (malls, lifts, pizza, holidays abroad). "
        f"Write only in the native {name} script; no transliteration, no English words in Hindi or Telugu items. "
        "Levels follow the ASER reading tools and NIPUN Bharat goals. Each level is a fixed standard, the same for "
        "every grade; do not make it harder or easier for older children. "
        + LEVEL_SPECS["en" if language == "en" else "state"]
        + " Avoid religious, political, violent or brand content."
    )
    wanted = ", ".join(f"{LEVEL_COUNTS[level]} {level} items" for level in LADDERS[language])
    user = (
        f"Create a reading-level assessment pack used with Grade {grade} children; choose themes and names familiar "
        f"to them. Return exactly {wanted}."
    )
    data = await claude_json(system, user, _content_schema(language), 6000)
    # Keep extras out rather than reject an otherwise valid pack; too few items still fails validation.
    trimmed = {level: list(dict.fromkeys(data.get(level, [])))[: PACK_LIMITS[level][1]] for level in LADDERS[language]}
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
        "levels": levels.for_language(language),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with _PACK_LOCK:
        path.write_text(json.dumps(pack, ensure_ascii=False, indent=1), encoding="utf-8")
    return pack
