"""Reading word packs: built-in seed packs, plus Claude-written packs generated once per
(language, grade), validated and cached so cost does not grow with the number of students."""
from __future__ import annotations

import json
import logging
import threading
import unicodedata
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ValidationError

from .auth import current_user
from .claude import claude_configured, claude_json, enforce_rate_limit
from .config import settings
from .languages import LADDERS, LANGUAGE_NAMES, MAX_GRADE, Language

logger = logging.getLogger("karya.content")
router = APIRouter(tags=["content"])
_PACK_LOCK = threading.Lock()

# Unicode block each language's reading items must use.
SCRIPT_RANGES = {"hi": (0x0900, 0x097F), "te": (0x0C00, 0x0C7F), "en": (0x0041, 0x007A)}
PACK_LIMITS = {
    "capital": (8, 12, 1), "letter": (8, 12, 4), "word": (8, 12, 16), "sentence": (4, 10, 60), "paragraph": (2, 4, 260), "story": (1, 2, 700),
}
# v2 added the story level; v3 the English ladder (capital letters, no paragraph/story);
# v4 English meaning hints and 4 sentences per English attempt (more sentences per pack);
# v5 Hindi/Telugu follow ASER's reading tool: no sentence level, ASER-style words, 2 paragraphs;
# v6 natural punctuation (commas, question marks, exclamations, quotes), not only full stops.
PACK_VERSION = 6
# Teacher app languages that get meaning hints for English items (an English-UI teacher needs none).
HINT_LANGUAGES = ("hi", "te")
MEANING_LEVELS = ("word", "sentence")

# Built-in draft packs. They are also bundled in the mobile app so a teacher can assess on the
# first day without any internet. A fluent early-literacy reviewer must check them before use.
SEED_PACKS: dict[str, dict[str, list[str]]] = {
    "en": {
        # English is a second language for most children here: common capitals and small letters,
        # regular 3-letter words (sounded out letter by letter), and short sentences built from them.
        "capital": ["A", "B", "C", "D", "M", "N", "P", "R", "S", "T"],
        "letter": ["a", "m", "s", "t", "p", "b", "r", "d", "n", "c"],
        "word": ["cat", "sun", "pen", "bus", "hen", "cup", "bag", "box", "red", "hat"],
        # Punctuated as in a textbook: questions, commas and exclamations, not only full stops.
        "sentence": [
            "I have a red bag.", "Is the sun hot?", "This is my pen.", "Look, the hen is big!", "I can run fast.",
            "My cup is red.", "Can you see a cat?", "Yes, I like my hat.",
        ],
    },
    "hi": {
        "letter": ["क", "म", "स", "र", "ल", "न", "ब", "प", "ग", "त"],
        # ASER words: 2 letters with 1 or 2 matras, no conjuncts.
        "word": ["पानी", "दूध", "नाक", "गाय", "बीज", "मोर", "तेल", "कान", "सेब", "रोटी"],
        # ASER Std I text: 4 simple linked sentences, each at most 6 words. Natural punctuation
        # (commas, ?, !, quotes) wherever a textbook would use it.
        "paragraph": [
            "मीना के पास एक गाय है। गाय का रंग सफ़ेद है। मीना रोज़ उसे घास खिलाती है। गाय मीना को दूध देती है।",
            "राजू की एक बिल्ली है। उसका नाम मिनी है। मिनी को दूध अच्छा लगता है। क्या तुमने मिनी को देखा?",
        ],
        "story": [
            "सोनू का एक छोटा भाई है, मोनू। एक दिन दोनों खेत में गए। वहाँ एक पेड़ पर आम लगे थे। "
            "मोनू बोला, \"भैया, मुझे आम चाहिए!\" पर पेड़ बहुत ऊँचा था। सोनू ने डंडे से दो आम गिराए। "
            "मोनू खुश हो गया। दोनों ने घर जाकर माँ के साथ आम खाए।"
        ],
    },
    "te": {
        "letter": ["అ", "క", "మ", "ర", "ల", "న", "ప", "స", "త", "గ"],
        # ASER words: 2 letters with 1 or 2 vowel signs, no conjuncts (ottulu) or anusvara.
        "word": ["పాలు", "బడి", "ఆవు", "నీరు", "చేప", "కోడి", "కాలు", "మేక", "పూలు", "తాడు"],
        # ASER Std I text: 4 simple linked sentences, each at most 6 words. Natural punctuation
        # (commas, ?, !, quotes) wherever a textbook would use it.
        "paragraph": [
            "రాము దగ్గర ఒక ఆవు ఉంది. ఆవు తెల్లగా, అందంగా ఉంది. రాము రోజూ ఆవుకు గడ్డి పెడతాడు. ఆవు రాముకు పాలు ఇస్తుంది.",
            "లత దగ్గర ఒక పిల్లి ఉంది. దాని పేరు చిన్ని. చిన్నికి పాలు అంటే ఇష్టం. మీరు చిన్నిని చూశారా?",
        ],
        "story": [
            "సీత ఒక చిన్న ఊరిలో ఉంటుంది. ఆమె దగ్గర ఒక కోడి ఉంది. ప్రతి రోజూ సీత కోడికి గింజలు వేస్తుంది. "
            "ఒక రోజు కోడి కనిపించలేదు! సీత ఇంటి వెనుక వెతికింది. కోడి గడ్డి కుప్ప దగ్గర కూర్చుంది. "
            "దాని కింద ఆరు గుడ్లు ఉన్నాయి. సీత సంతోషంగా, \"అమ్మా, చూడు!\" అని పిలిచింది."
        ],
    },
}

# Practice items: same level standards as the check, but none of the check's items, so a child who
# practises does not meet the next check's items in advance. Also drafts for review.
SEED_PRACTICE: dict[str, dict[str, list[str]]] = {
    "en": {
        "capital": ["E", "F", "G", "H", "K", "L", "O", "U", "W", "Y"],
        "letter": ["e", "f", "g", "h", "i", "j", "k", "l", "o", "u"],
        "word": ["dog", "pot", "bat", "fan", "jug", "mat", "sit", "top", "van", "leg"],
        "sentence": [
            "The dog is big.", "Can you see my bat?", "Sit on the mat.", "Look, the fan is on!",
            "My pot is hot.", "Yes, I have a jug.", "Is the van red?", "I can hop.",
        ],
    },
    "hi": {
        "letter": ["ज", "द", "ह", "च", "य", "व", "ट", "ड", "फ", "भ"],
        "word": ["दाल", "फूल", "भालू", "बाल", "हाथ", "पैर", "जूता", "केला", "मेज़", "नदी"],
        "paragraph": [
            "रानी के पास एक तोता है। तोते का रंग हरा है। वह रोज़ मीठे आम खाता है। क्या तोता बोल सकता है?",
            "आज बारिश हो रही है। गोलू छाता लेकर निकला। रास्ते में पानी भरा था। वाह, कितनी मज़ेदार बारिश!",
        ],
        "story": [
            "पिंकी के पास एक छोटा पिल्ला है। उसका नाम मोती है। एक दिन मोती घर से भाग गया। "
            "पिंकी ने गली में आवाज़ लगाई, \"मोती, कहाँ हो?\" पेड़ के पीछे से भौं-भौं की आवाज़ आई। "
            "मोती वहाँ गेंद से खेल रहा था। पिंकी हँस पड़ी। दोनों खुशी-खुशी घर लौट आए।"
        ],
    },
    "te": {
        "letter": ["ఆ", "ఇ", "చ", "ద", "బ", "వ", "య", "జ", "ట", "హ"],
        "word": ["పాప", "కోతి", "చీమ", "తేనె", "బాతు", "గాలి", "రాయి", "ఈగ", "కాకి", "మేడ"],
        "paragraph": [
            "రవి దగ్గర ఒక చిలుక ఉంది. చిలుక పచ్చగా ఉంది. అది రోజూ జామపండు తింటుంది. చిలుక మాట్లాడగలదా?",
            "ఈరోజు వర్షం పడుతోంది. గోపి గొడుగు పట్టుకున్నాడు. దారిలో నీళ్ళు నిండాయి. ఆహా, ఎంత మంచి వర్షం!",
        ],
        "story": [
            "పింకీ దగ్గర ఒక చిన్న కుక్కపిల్ల ఉంది. దాని పేరు మోతీ. ఒక రోజు మోతీ ఇంటి నుంచి పారిపోయింది. "
            "పింకీ వీధిలో, \"మోతీ, ఎక్కడ ఉన్నావు?\" అని పిలిచింది. చెట్టు వెనుక నుంచి భౌ భౌ అని వినిపించింది. "
            "మోతీ అక్కడ బంతితో ఆడుకుంటోంది. పింకీ నవ్వింది. ఇద్దరూ సంతోషంగా ఇంటికి వెళ్ళారు."
        ],
    },
}
PackKind = Literal["check", "practice"]

# Sample meanings of the English seed words and sentences, shown to a Hindi- or Telugu-UI teacher
# during the meaning check. Any correct answer from the child counts; these only help the teacher
# judge. Drafts: a fluent reviewer must check them.
SEED_MEANINGS: dict[str, dict[str, str]] = {
    "hi": {
        "cat": "बिल्ली", "sun": "सूरज", "pen": "पेन, कलम", "bus": "बस", "hen": "मुर्गी", "cup": "कप, प्याला",
        "bag": "बस्ता, थैला", "box": "डिब्बा", "red": "लाल", "hat": "टोपी",
        "I have a red bag.": "मेरे पास एक लाल बस्ता है।",
        "Is the sun hot?": "क्या सूरज गरम है?",
        "This is my pen.": "यह मेरा पेन है।",
        "Look, the hen is big!": "देखो, मुर्गी बड़ी है!",
        "I can run fast.": "मैं तेज़ दौड़ सकता/सकती हूँ।",
        "My cup is red.": "मेरा कप लाल है।",
        "Can you see a cat?": "क्या तुम्हें बिल्ली दिख रही है?",
        "Yes, I like my hat.": "हाँ, मुझे अपनी टोपी पसंद है।",
    },
    "te": {
        "cat": "పిల్లి", "sun": "సూర్యుడు", "pen": "పెన్, కలం", "bus": "బస్సు", "hen": "కోడి", "cup": "కప్పు",
        "bag": "సంచి", "box": "పెట్టె", "red": "ఎరుపు", "hat": "టోపీ",
        "I have a red bag.": "నా దగ్గర ఒక ఎర్ర సంచి ఉంది.",
        "Is the sun hot?": "ఎండ వేడిగా ఉందా?",
        "This is my pen.": "ఇది నా కలం.",
        "Look, the hen is big!": "చూడు, కోడి పెద్దగా ఉంది!",
        "I can run fast.": "నేను వేగంగా పరిగెత్తగలను.",
        "My cup is red.": "నా కప్పు ఎర్రగా ఉంది.",
        "Can you see a cat?": "నీకు పిల్లి కనిపిస్తోందా?",
        "Yes, I like my hat.": "అవును, నాకు నా టోపీ అంటే ఇష్టం.",
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
    # English only: hint language -> {item: meaning}. Never makes a pack invalid; see clean_meanings.
    meanings: dict[str, dict[str, str]] = {}

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


def clean_meanings(levels: ContentLevels) -> dict[str, dict[str, str]]:
    """Keep hints only for this pack's English words and sentences, in the hint language's script."""
    items = {item for level in MEANING_LEVELS for item in getattr(levels, level)}
    cleaned = {}
    for lang in HINT_LANGUAGES:
        given = levels.meanings.get(lang, {})
        cleaned[lang] = {
            item: text.strip() for item, text in given.items()
            if item in items and 0 < len(text.strip()) <= 120 and _in_script(text, lang)
        }
    return cleaned


def seed_pack(language: str, grade: int, kind: PackKind = "check") -> dict:
    pack = {
        "pack_id": f"seed-{language}-{kind}-v{PACK_VERSION}" if kind == "practice" else f"seed-{language}-v{PACK_VERSION}",
        "language": language,
        "grade": grade,
        "version": PACK_VERSION,
        "kind": kind,
        "source": "seed",
        "reviewed": False,
        "levels": SEED_PRACTICE[language] if kind == "practice" else SEED_PACKS[language],
    }
    if language == "en" and kind == "check":
        pack["meanings"] = SEED_MEANINGS
    return pack


def _pack_path(language: str, grade: int, kind: PackKind = "check"):
    suffix = "_practice" if kind == "practice" else ""
    return settings.pack_dir / f"{language}_g{grade}{suffix}_v{PACK_VERSION}.json"


def _content_schema(language: str, with_meanings: bool) -> dict:
    def arr(level: str) -> dict:
        # Structured outputs reject minItems/maxItems; validate_levels enforces counts afterwards.
        return {"type": "array", "items": {"type": "string", "maxLength": PACK_LIMITS[level][2]}}

    properties = {level: arr(level) for level in LADDERS[language]}
    if with_meanings:
        # One entry per word and sentence: the item and its meaning in each hint language.
        entry = {lang: {"type": "string", "maxLength": 120} for lang in HINT_LANGUAGES}
        properties["meanings"] = {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "properties": {"item": {"type": "string", "maxLength": 60}, **entry},
            "required": ["item", *HINT_LANGUAGES],
        }}
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties),
    }


# What each level means. Each level is a fixed standard for every grade.
LEVEL_SPECS = {
    "state": (
        "This follows ASER's reading tool. letter: single common basic letters (no conjuncts). "
        "word: common, familiar words of exactly 2 letters with 1 or 2 vowel signs (matras), no conjuncts and no "
        "anusvara. paragraph (Std 1 text): 4 simple linked sentences about one familiar topic, each at most 6 words, "
        "using words from Std 1 textbooks. story (Std 2 text): a short story of 7-10 simple sentences with "
        "straightforward construction and commonly used words, about 50-80 words, using words from Std 2 textbooks."
    ),
    "en": (
        "English is a second language for these children: they learn to read first in their home or state language "
        "and hear little English outside school. capital: single common capital letters. letter: single common small "
        "letters. word: 3-letter, phonetically regular words a child can sound out (consonant-vowel-consonant), using "
        "only very common nouns, colours and actions. sentence: simple sentences of 4-5 words built mostly from such "
        "words and common sight words (I, a, the, is, my, can), one per item. "
        "meanings: for every word and sentence item, give the item exactly as written and its simple, everyday "
        "meaning in Hindi (Devanagari) and Telugu (Telugu script), the way a child would say it at home. A teacher "
        "uses these as a hint when the child explains the meaning in their own language."
    ),
}
# Only English has sentences; an attempt shows 4 (ASER), so the pack needs more of them.
LEVEL_COUNTS = {"capital": 10, "letter": 10, "word": 10, "sentence": 8, "paragraph": 2, "story": 2}


async def _generate_pack(language: str, grade: int, kind: PackKind = "check", avoid: frozenset[str] = frozenset()) -> ContentLevels:
    """Write one pack. A practice pack follows the same standards with different items from `avoid`
    (the check pack's items), so practice does not give away the next check."""
    name = LANGUAGE_NAMES[language]
    with_meanings = language == "en" and kind == "check"
    system = (
        f"You write early-reading assessment items in {name} for children in government and low-income schools in "
        "rural India, where many children in Grades 1-3 are still learning letters and simple words. "
        "Use very common, concrete, culturally familiar vocabulary (home, farm, food, animals, family, school); avoid "
        "objects and experiences that rural children may not know (malls, lifts, pizza, holidays abroad). "
        f"Write only in the native {name} script; no transliteration, no English words in Hindi or Telugu items. "
        "Levels follow the ASER reading tools and NIPUN Bharat goals. Each level is a fixed standard, the same for "
        "every grade; do not make it harder or easier for older children. "
        + LEVEL_SPECS["en" if language == "en" else "state"]
        + " Punctuate sentences, paragraphs and stories the way a good textbook does: commas, question marks, "
        "exclamation marks and quotation marks for speech wherever they belong, not only full stops (or the danda "
        "in Hindi). Include some questions and some speech. Use straight quotes (\") and no apostrophes or "
        "contractions."
        + " Avoid religious, political, violent or brand content."
    )
    wanted = ", ".join(f"{LEVEL_COUNTS[level]} {level} items" for level in LADDERS[language])
    user = (
        f"Create a reading-level assessment pack used with Grade {grade} children; choose themes and names familiar "
        f"to them. Return exactly {wanted}."
    )
    if kind == "practice":
        user += (
            " This is the PRACTICE set a teacher uses between checks, so every item must differ from the check items: "
            + json.dumps(sorted(avoid), ensure_ascii=False)
            + ". Do not include meanings."
        )
    data = await claude_json(system, user, _content_schema(language, with_meanings), 6000)
    # Keep extras out rather than reject an otherwise valid pack; too few items still fails validation.
    # Practice items that repeat a check item are dropped here, so the count check catches a bad set.
    trimmed = {
        level: [item for item in dict.fromkeys(data.get(level, [])) if item not in avoid][: PACK_LIMITS[level][1]]
        for level in LADDERS[language]
    }
    meanings = {lang: {} for lang in HINT_LANGUAGES}
    for entry in data.get("meanings", []):
        for lang in HINT_LANGUAGES:
            meanings[lang][entry.get("item", "")] = entry.get(lang, "")
    return ContentLevels.model_validate({**trimmed, "meanings": meanings})


def _check_items(language: str, grade: int) -> frozenset[str]:
    """Every item a check can show for this language and grade: the seed pack and any cached Claude pack."""
    items = {item for level in LADDERS[language] for item in SEED_PACKS[language].get(level, [])}
    path = _pack_path(language, grade)
    if path.exists():
        cached = json.loads(path.read_text(encoding="utf-8"))
        items.update(item for level_items in cached.get("levels", {}).values() for item in level_items)
    return frozenset(items)


@router.get("/content-pack", dependencies=[Depends(current_user)])  # signed-in users only: may call Claude
async def content_pack(request: Request, language: Language = "hi", grade: int = 2, kind: PackKind = "check"):
    """Return a cached Claude-generated pack (check items, or practice items), generating it once if
    Claude is configured.

    Falls back to the seed pack offline, in demo mode, or when generation fails validation.
    """
    if not 1 <= grade <= MAX_GRADE:
        raise HTTPException(status_code=422, detail=f"grade must be between 1 and {MAX_GRADE}")
    path = _pack_path(language, grade, kind)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if not claude_configured():
        return seed_pack(language, grade, kind)
    enforce_rate_limit(request)
    try:
        avoid = _check_items(language, grade) if kind == "practice" else frozenset()
        levels = await _generate_pack(language, grade, kind=kind, avoid=avoid)
        problems = validate_levels(levels, language)
        if problems:
            logger.warning("Generated %s %s pack rejected: %s", language, kind, problems[:5])
            return seed_pack(language, grade, kind)
    except (httpx.HTTPError, ValueError, ValidationError) as exc:
        logger.warning("Content pack generation failed: %s", type(exc).__name__)
        return seed_pack(language, grade, kind)
    pack = {
        "pack_id": f"claude-{language}-g{grade}-{kind}-v{PACK_VERSION}" if kind == "practice" else f"claude-{language}-g{grade}-v{PACK_VERSION}",
        "language": language,
        "grade": grade,
        "version": PACK_VERSION,
        "kind": kind,
        "source": "claude",
        "reviewed": False,
        "levels": levels.for_language(language),
    }
    if language == "en" and kind == "check":
        pack["meanings"] = clean_meanings(levels)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _PACK_LOCK:
        path.write_text(json.dumps(pack, ensure_ascii=False, indent=1), encoding="utf-8")
    return pack
