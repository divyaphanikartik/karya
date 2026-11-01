"""Teacher note for one reading attempt. The phone sends the teacher's per-word marks and the
transcript from its offline speech model (text only, never audio); Claude compares the two views.
The output is a second opinion for the teacher, not a validated pronunciation score."""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from .auth import current_user
from .claude import claude_configured, claude_json, enforce_rate_limit
from .languages import LANGUAGE_NAMES, MAX_GRADE, Language, Level

logger = logging.getLogger("karya.assess")
router = APIRouter(tags=["assessment"])

_PUNCT = re.compile(r"[\s\.,!?;:\"'“”‘’।॥()\-–—]+")


def tokenize(text: str) -> list[str]:
    text = unicodedata.normalize("NFC", text).lower()
    return [t for t in _PUNCT.split(text) if t]


def _swapped(expected: list[str], heard: list[str], i: int, j: int) -> bool:
    return (i >= 2 and j >= 2 and expected[i - 1] != expected[i - 2]
            and expected[i - 1] == heard[j - 2] and expected[i - 2] == heard[j - 1])


def align(expected: list[str], heard: list[str]) -> list[dict]:
    """Word-level edit alignment. Ops: correct, substitution, omission, insertion.

    A substitution costs 1.5 (less than omission + insertion = 2) so a single misread word stays a
    substitution, while a skipped word does not shift every following word into a "substitution".
    """
    sub = 1.5
    n, m = len(expected), len(heard)
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = float(i)
    for j in range(m + 1):
        dp[0][j] = float(j)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0.0 if expected[i - 1] == heard[j - 1] else sub
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
            if _swapped(expected, heard, i, j):
                dp[i][j] = min(dp[i][j], dp[i - 2][j - 2] + sub)
    ops: list[dict] = []
    i, j = n, m
    while i > 0 or j > 0:
        if _swapped(expected, heard, i, j) and dp[i][j] == dp[i - 2][j - 2] + sub:
            # Two neighbouring items read in each other's place (G B heard as B G): two substitutions,
            # not one skipped item plus one extra, so the confusion is visible.
            ops.append({"op": "substitution", "expected": expected[i - 1], "heard": heard[j - 1]})
            ops.append({"op": "substitution", "expected": expected[i - 2], "heard": heard[j - 2]})
            i, j = i - 2, j - 2
        elif i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (0.0 if expected[i - 1] == heard[j - 1] else sub):
            op = "correct" if expected[i - 1] == heard[j - 1] else "substitution"
            ops.append({"op": op, "expected": expected[i - 1], "heard": heard[j - 1]})
            i, j = i - 1, j - 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            ops.append({"op": "omission", "expected": expected[i - 1], "heard": None})
            i -= 1
        else:
            ops.append({"op": "insertion", "expected": None, "heard": heard[j - 1]})
            j -= 1
    return list(reversed(ops))


def asr_word_marks(expected: list[str], alignment: list[dict]) -> list[bool]:
    """Per expected token: did the recognizer hear it correctly?"""
    marks = []
    for op in alignment:
        if op["expected"] is not None:
            marks.append(op["op"] == "correct")
    return marks[: len(expected)]


class AttemptMeta(BaseModel):
    attempt_id: str = Field(min_length=1, max_length=80)
    language: Language
    level: Level
    grade: int = Field(ge=1, le=MAX_GRADE)
    expected_items: list[str] = Field(min_length=1, max_length=12)
    teacher_marks: list[bool] = Field(max_length=120)  # per expected token, True = read correctly
    duration_sec: float | None = Field(default=None, ge=0, le=600)
    # Produced by the on-device speech model; the server never receives audio.
    asr_transcript: str | None = Field(default=None, max_length=2000)
    asr_model: str | None = Field(default=None, max_length=80)
    # The teacher's app language: the note is written in it (misread words stay in their own script).
    note_language: Language = "en"


ERROR_PATTERNS = (
    "letter_confusion", "vowel_sign_matra", "conjunct_letters", "word_skipped",
    "word_substituted", "guessing_from_first_letter", "slow_letter_by_letter", "none_observed",
)


class TeacherFeedback(BaseModel):
    agreement: Literal["agrees", "partly_agrees", "disagrees", "no_transcript"]
    error_patterns: list[Literal[ERROR_PATTERNS]] = Field(max_length=4)
    note_for_teacher: str = Field(min_length=1, max_length=400)
    practice_suggestion: str = Field(min_length=1, max_length=300)


def _feedback_schema() -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "agreement": {"type": "string", "enum": ["agrees", "partly_agrees", "disagrees", "no_transcript"]},
            "error_patterns": {"type": "array", "items": {"type": "string", "enum": list(ERROR_PATTERNS)}},
            "note_for_teacher": {"type": "string", "maxLength": 400},
            "practice_suggestion": {"type": "string", "maxLength": 300},
        },
        "required": ["agreement", "error_patterns", "note_for_teacher", "practice_suggestion"],
    }


# Fixed-rule note text per app language. Hindi and Telugu are drafts for fluent review.
RULE_TEXT = {
    "en": {
        "marked": "Teacher marked {missed} of {total} as misread",
        "practise": "Practise the misread items aloud together, then re-check them next week.",
        "next_level": "Try the next level up in the next session.",
    },
    "hi": {
        "marked": "{total} में से {missed} शब्द गलत पढ़े गए (शिक्षक के अंक)",
        "practise": "गलत पढ़े गए शब्दों का साथ में ज़ोर से अभ्यास करें, फिर अगले सप्ताह दोबारा जाँचें।",
        "next_level": "अगली बार अगले स्तर की जाँच करें।",
    },
    "te": {
        "marked": "{total} లో {missed} తప్పుగా చదివారు (ఉపాధ్యాయుల గుర్తింపు)",
        "practise": "తప్పుగా చదివిన పదాలను కలిసి గట్టిగా సాధన చేయించండి, వచ్చే వారం మళ్ళీ పరీక్షించండి.",
        "next_level": "తదుపరి సారి పై స్థాయిని ప్రయత్నించండి.",
    },
}


def rule_feedback(meta: AttemptMeta, alignment: list[dict] | None, asr_marks: list[bool] | None) -> TeacherFeedback:
    """Deterministic note used in demo mode or when Claude output fails validation."""
    if asr_marks is None:
        agreement = "no_transcript"
    else:
        same = sum(a == t for a, t in zip(asr_marks, meta.teacher_marks))
        ratio = same / max(1, len(meta.teacher_marks))
        agreement = "agrees" if ratio >= 0.9 else "partly_agrees" if ratio >= 0.6 else "disagrees"
    missed = [tok for tok, ok in zip(_expected_tokens(meta), meta.teacher_marks) if not ok]
    patterns: list = []
    if alignment and any(op["op"] == "omission" for op in alignment):
        patterns.append("word_skipped")
    if alignment and any(op["op"] == "substitution" for op in alignment):
        patterns.append("word_substituted")
    if not patterns:
        patterns = ["none_observed"] if not missed else []
    text = RULE_TEXT[meta.note_language]
    note = (
        text["marked"].format(missed=len(missed), total=len(meta.teacher_marks))
        + (f": {', '.join(missed[:6])}." if missed else ".")
    )
    return TeacherFeedback(
        agreement=agreement,
        error_patterns=patterns[:4],
        note_for_teacher=note,
        practice_suggestion=text["practise"] if missed else text["next_level"],
    )


def _expected_tokens(meta: AttemptMeta) -> list[str]:
    return [tok for item in meta.expected_items for tok in tokenize(item)]


async def claude_feedback(meta: AttemptMeta, transcript: str | None, alignment: list[dict] | None) -> TeacherFeedback:
    payload = {
        "language": LANGUAGE_NAMES[meta.language],
        "grade": meta.grade,
        "level": meta.level,
        "expected_text": meta.expected_items,
        "teacher_marks_per_word": list(zip(_expected_tokens(meta), meta.teacher_marks)),
        "speech_transcript": transcript,
        "alignment": alignment,
        "reading_duration_seconds": meta.duration_sec,
    }
    system = (
        "You help a primary teacher in a rural Indian government school review one short reading-aloud attempt by a child. "
        "Many children here are still learning letters and simple words. For English, a second language learned after "
        "the home or state language, sounding words out letter by letter and reading slowly are normal at this stage; "
        "do not treat them as problems. The level 'capital' means English capital letters and 'letter' means small letters. "
        "Two independent views are given: the teacher's per-word marks, and a transcript from an offline speech "
        "model on the phone. The speech model can mishear children, short words and noisy classrooms, and the "
        "teacher can miss errors, so neither is the reference; say where they agree and where they differ. "
        "Compare them, set agreement, and name at most 4 error patterns supported by the evidence. "
        f"Write note_for_teacher and practice_suggestion in simple {LANGUAGE_NAMES[meta.note_language]} "
        f"({LANGUAGE_NAMES[meta.note_language]} is the teacher's app language), one or two short sentences each, "
        "quoting misread words in their original script. Never diagnose a disability or give a score. "
        "If speech_transcript is null or empty, set agreement to no_transcript and base the note on the teacher's marks "
        "alone; do not ask the teacher to record or re-record (speech may not be available on their device)."
    )
    data = await claude_json(system, json.dumps(payload, ensure_ascii=False), _feedback_schema(), 2000)
    data["error_patterns"] = list(dict.fromkeys(data.get("error_patterns", [])))[:4]
    return TeacherFeedback.model_validate(data)


@router.post("/assess-reading", dependencies=[Depends(current_user)])  # signed-in users only: calls Claude
async def assess_reading(attempt: AttemptMeta, request: Request):
    """Claude note for one attempt: teacher marks plus the optional on-device transcript (text only)."""
    expected = _expected_tokens(attempt)
    if len(attempt.teacher_marks) != len(expected):
        raise HTTPException(status_code=422, detail=f"teacher_marks must have one entry per word ({len(expected)}).")

    transcript = (attempt.asr_transcript or "").strip() or None
    alignment = asr_marks = None
    if transcript:
        alignment = align(expected, tokenize(transcript))
        asr_marks = asr_word_marks(expected, alignment)

    source = "rules"
    feedback = rule_feedback(attempt, alignment, asr_marks)
    if claude_configured():
        enforce_rate_limit(request)
        try:
            feedback = await claude_feedback(attempt, transcript, alignment)
            source = "claude"
        except (httpx.HTTPError, ValueError, ValidationError) as exc:
            logger.warning("Claude feedback failed, using rules: %s", type(exc).__name__)
            source = "rule_fallback"

    teacher_accuracy = sum(attempt.teacher_marks) / len(expected)
    words_correct = sum(attempt.teacher_marks)
    wcpm = round(words_correct * 60 / attempt.duration_sec, 1) if attempt.duration_sec and attempt.level in ("sentence", "paragraph", "story") else None
    return {
        "attempt_id": attempt.attempt_id,
        "transcript": transcript,
        "asr_model": attempt.asr_model if transcript else None,
        "alignment": alignment,
        "asr_accuracy": round(sum(asr_marks) / len(asr_marks), 3) if asr_marks else None,
        "teacher_accuracy": round(teacher_accuracy, 3),
        "words_correct_per_minute": wcpm,
        "feedback": feedback.model_dump(),
        "feedback_source": source,
        "disclaimer": "AI second opinion for the teacher; not a validated pronunciation or reading score.",
    }


# ---- Whole-check summary and retest -------------------------------------------------------------------
# After every section of a check has its own note, one more call reads them all together: a one-line
# conclusion per section, an overall summary, and a short retest built from the child's actual mistakes.

class SectionMeta(BaseModel):
    level: Level
    expected_items: list[str] = Field(min_length=1, max_length=12)
    teacher_marks: list[bool] = Field(max_length=120)
    asr_transcript: str | None = Field(default=None, max_length=2000)


class SessionMeta(BaseModel):
    session_id: str = Field(min_length=1, max_length=80)
    language: Language
    grade: int = Field(ge=1, le=MAX_GRADE)
    note_language: Language = "en"
    sections: list[SectionMeta] = Field(min_length=1, max_length=8)


RETEST_MAX_ITEMS = 8
# Letters and words can be rebuilt around the child's confusions; longer texts are simply re-read.
RETEST_BUILDABLE = ("capital", "letter", "word")


def _section_view(section: SectionMeta) -> dict:
    expected = [tok for item in section.expected_items for tok in tokenize(item)]
    transcript = (section.asr_transcript or "").strip() or None
    alignment = align(expected, tokenize(transcript)) if transcript else None
    missed = [tok for tok, ok in zip(expected, section.teacher_marks) if not ok]
    flagged = []
    heard_right_marked_wrong = []
    if alignment:
        flagged = [op["expected"] for op in alignment if op["expected"] is not None and op["op"] != "correct"]
        per_word = [op for op in alignment if op["expected"] is not None]
        heard_right_marked_wrong = [
            op["expected"] for op, ok in zip(per_word, section.teacher_marks) if op["op"] == "correct" and not ok
        ]
    return {
        "level": section.level,
        "expected_items": section.expected_items,
        "teacher_missed": missed,
        "speech_transcript": transcript,
        "teacher_marked_wrong_but_speech_heard_correctly": heard_right_marked_wrong,
        "speech_mismatches": [
            {"expected": op["expected"], "heard": op["heard"], "kind": op["op"]}
            for op in (alignment or []) if op["op"] != "correct"
        ],
        "_flagged": flagged,
    }


def _misread_items(section: dict) -> list[str]:
    """The items the teacher marked misread, as printed in the check (a capital stays a capital)."""
    by_token = {}
    for item in section["expected_items"]:
        tokens = tokenize(item)
        if len(tokens) == 1:
            by_token[tokens[0]] = item
    return list(dict.fromkeys(by_token.get(tok, tok) for tok in section["teacher_missed"]))


def _retest_section(sections: list[dict]) -> dict | None:
    """The section with the most misreads (the earliest if tied); None if the teacher marked nothing wrong."""
    best = None
    for sec in sections:
        if sec["teacher_missed"] and (best is None or len(sec["teacher_missed"]) > len(best["teacher_missed"])):
            best = sec
    return best


def _retest_from_mistakes(sections: list[dict]) -> dict | None:
    """Rule-based retest: what was misread last time. Longer texts are simply read again."""
    sec = _retest_section(sections)
    if not sec:
        return None
    if sec["level"] in RETEST_BUILDABLE:
        return {"level": sec["level"], "items": _misread_items(sec)[:RETEST_MAX_ITEMS]}
    return {"level": sec["level"], "items": sec["expected_items"][:RETEST_MAX_ITEMS]}


def rule_session_summary(meta: SessionMeta, sections: list[dict]) -> dict:
    text = RULE_TEXT[meta.note_language]
    headlines = []
    for sec, section in zip(sections, meta.sections):
        total = len(section.teacher_marks)
        headlines.append({"level": sec["level"], "headline": text["marked"].format(missed=len(sec["teacher_missed"]), total=total) + "."})
    retest = _retest_from_mistakes(sections)
    return {
        "sections": headlines,
        "summary": text["practise"] if retest else text["next_level"],
        "retest": retest,
    }


def _session_schema(levels: list[str]) -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "sections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"level": {"type": "string", "enum": levels}, "headline": {"type": "string", "maxLength": 160}},
                    "required": ["level", "headline"],
                },
            },
            "summary": {"type": "string", "maxLength": 400},
            "retest_level": {"type": "string", "enum": levels},
            "retest_items": {"type": "array", "items": {"type": "string", "maxLength": 60}},
        },
        "required": ["sections", "summary", "retest_level", "retest_items"],
    }


async def claude_session_summary(meta: SessionMeta, sections: list[dict]) -> dict:
    levels = list(dict.fromkeys(sec["level"] for sec in sections))
    payload = {
        "language": LANGUAGE_NAMES[meta.language],
        "grade": meta.grade,
        "sections": [{k: v for k, v in sec.items() if not k.startswith("_")} for sec in sections],
    }
    system = (
        "You help a primary teacher in a rural Indian government school understand one child's reading check. "
        "Each section lists what the teacher marked misread and where an offline speech model heard something "
        "different from the expected text (a mismatch such as expected G, heard B). The speech model can mishear, "
        "so treat a mismatch as a hint, not proof. Also say when the teacher marked an item wrong but the speech model heard it correctly (it may deserve a second listen). "
        f"Write in simple {LANGUAGE_NAMES[meta.note_language]} (the teacher's app language), keeping the child's "
        "words and letters in their own script. For every section give one short headline sentence saying what went "
        "well and where the mistakes were (name the letters or words). Then give a summary of at most three short "
        "sentences covering the whole check. Finally design extra practice items for a retest: choose the one section "
        "that needs it most, and give a few NEW items (not the ones the teacher marked misread; those are added "
        f"automatically), at most {RETEST_MAX_ITEMS} in the language's own script at that section's level, that follow "
        "the pattern of what went wrong (for example, if G and B were mixed up, other letters that look or sound alike "
        "such as P, D and R; for words, words with the same tricky sound or letters). For a paragraph or story "
        "section give no extras. Never diagnose a disability or give a score."
    )
    data = await claude_json(system, json.dumps(payload, ensure_ascii=False), _session_schema(levels), 2500)
    return data


def _build_retest(level: str, extras: list, language: str, sections: list[dict]) -> dict | None:
    """What was misread last time, plus Claude's extra items that follow the same pattern.

    The misread items always come first and unchanged. Claude's extras are kept only if they are safe to
    put in front of a child: in the right script, a sensible size, and not repeats. Longer texts have no extras."""
    from .content import PACK_LIMITS, _in_script

    section = next((sec for sec in sections if sec["level"] == level), None)
    if section is None:
        return None
    if level not in RETEST_BUILDABLE:
        return {"level": level, "items": section["expected_items"][:RETEST_MAX_ITEMS]}
    items = _misread_items(section)
    seen = {item.casefold() for item in items}
    max_len = PACK_LIMITS[level][2]
    for item in extras if isinstance(extras, list) else []:
        text = item.strip() if isinstance(item, str) else ""
        if text and len(text) <= max_len and _in_script(text, language) and text.casefold() not in seen:
            items.append(text)
            seen.add(text.casefold())
    return {"level": level, "items": items[:RETEST_MAX_ITEMS]} if items else None


@router.post("/assess-session", dependencies=[Depends(current_user)])  # signed-in users only: calls Claude
async def assess_session(meta: SessionMeta, request: Request):
    """One-line conclusion per section, an overall summary and a retest, from the whole check."""
    for section in meta.sections:
        expected = [tok for item in section.expected_items for tok in tokenize(item)]
        if len(section.teacher_marks) != len(expected):
            raise HTTPException(status_code=422, detail=f"teacher_marks must have one entry per word ({len(expected)}).")
    sections = [_section_view(s) for s in meta.sections]
    result = rule_session_summary(meta, sections)
    source = "rules"
    if claude_configured():
        enforce_rate_limit(request)
        try:
            data = await claude_session_summary(meta, sections)
            headlines = {h["level"]: h["headline"] for h in data.get("sections", []) if h.get("headline")}
            result["sections"] = [
                {"level": sec["level"], "headline": headlines.get(sec["level"]) or old["headline"]}
                for sec, old in zip(sections, result["sections"])
            ]
            result["summary"] = str(data["summary"]).strip() or result["summary"]
            result["retest"] = (
                _build_retest(data.get("retest_level", ""), data.get("retest_items", []), meta.language, sections)
                or result["retest"]
            )
            source = "claude"
        except (httpx.HTTPError, ValueError, KeyError, ValidationError) as exc:
            logger.warning("Claude session summary failed, using rules: %s", type(exc).__name__)
            source = "rule_fallback"
    return {"session_id": meta.session_id, "source": source, **result}
