"""Sync between phones and the server. Requires a signed-in teacher; every record is tagged with
that teacher's school and id from the token (never from the request body).

Students belong to a school, identified by roll number. If two teachers add the same child offline,
the server keeps the first record and tells the second phone to use its id (`student_ids`), so the
child's checks and practice from both teachers end up on one record. Audio never arrives here.
"""
from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .auth import User, current_user, require_teacher
from .db import connect, now
from .languages import Language, Level

router = APIRouter(tags=["sync"])


class SyncStudent(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    student_code: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=80)
    grade: int = Field(ge=1, le=5)
    language: Language
    updated_at: str = Field(max_length=48)
    next_review: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")  # the teacher's review date


class SyncSession(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    student_id: str = Field(min_length=1, max_length=80)
    language: Language
    grade: int = Field(ge=1, le=5)
    placed_level: int | None = Field(default=None, ge=0, le=4)  # 0 beginner ... top of the ladder (4 steps)
    needs_help: bool | None = None
    started_at: str = Field(max_length=48)
    finished_at: str | None = Field(default=None, max_length=48)
    # English meaning check (ASER): explained / asked, and whether that counts as "can say".
    meaning_level: Literal["word", "sentence"] | None = None
    meaning_correct: int | None = Field(default=None, ge=0, le=5)
    meaning_total: int | None = Field(default=None, ge=0, le=5)
    meaning_can_say: bool | None = None


class SyncAttempt(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    session_id: str = Field(min_length=1, max_length=80)
    level: Level
    items: list[str] = Field(default_factory=list, max_length=12)
    marks: list[bool] = Field(default_factory=list, max_length=200)  # per word, True = read correctly
    accuracy: float = Field(ge=0, le=1)
    passed: bool
    duration_sec: float | None = Field(default=None, ge=0, le=600)
    ai_result: dict | None = None
    created_at: str = Field(max_length=48)
    fluent: bool | None = None  # paragraph/story: the teacher's ASER fluency judgement


class SyncPractice(BaseModel):
    """One practice round between checks: counts only."""
    id: str = Field(min_length=1, max_length=80)
    student_id: str = Field(min_length=1, max_length=80)
    level: Level
    correct: int = Field(ge=0, le=200)
    total: int = Field(ge=1, le=200)
    fluent: bool | None = None
    passed: bool
    created_at: str = Field(max_length=48)


class SyncPracticePlan(BaseModel):
    """Missed items the teacher moved to a later day: level, item count, day, and when it was done."""
    id: str = Field(min_length=1, max_length=80)
    student_id: str = Field(min_length=1, max_length=80)
    level: Level
    item_count: int = Field(ge=1, le=20)
    due_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    done_at: str | None = Field(default=None, max_length=48)
    created_at: str = Field(max_length=48)


class SyncRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=80)
    students: list[SyncStudent] = Field(default_factory=list, max_length=500)
    sessions: list[SyncSession] = Field(default_factory=list, max_length=500)
    attempts: list[SyncAttempt] = Field(default_factory=list, max_length=2000)
    practice: list[SyncPractice] = Field(default_factory=list, max_length=2000)
    practice_plans: list[SyncPracticePlan] = Field(default_factory=list, max_length=2000)


def _bool(value: bool | None) -> int | None:
    return None if value is None else int(value)


@router.post("/sync")
async def sync(req: SyncRequest, user: User = Depends(require_teacher)):
    received = now()
    school = user.school_id
    accepted: dict[str, list[str]] = {"students": [], "sessions": [], "attempts": [], "practice": [], "practice_plans": []}
    student_ids: dict[str, str] = {}  # phone id -> server id, when the child already existed
    rejected: list[dict] = []

    with connect() as conn:
        def own_student(phone_id: str) -> str | None:
            """The server id of a student in this school (after any merge), or None."""
            student_id = student_ids.get(phone_id, phone_id)
            row = conn.execute("SELECT school_id FROM students WHERE id = ?", (student_id,)).fetchone()
            return student_id if row and row["school_id"] == school else None

        for s in req.students:
            by_id = conn.execute("SELECT school_id, updated_at FROM students WHERE id = ?", (s.id,)).fetchone()
            if by_id and by_id["school_id"] != school:
                rejected.append({"type": "student", "id": s.id, "reason": "belongs to another school"})
                continue
            target = s.id
            if not by_id:
                same_roll = conn.execute(
                    "SELECT id, updated_at FROM students WHERE school_id = ? AND student_code = ?", (school, s.student_code),
                ).fetchone()
                if same_roll:
                    target = same_roll["id"]
                    student_ids[s.id] = target
                    by_id = same_roll
            if by_id is None:
                conn.execute(
                    "INSERT INTO students (id, school_id, student_code, name, grade, language, created_by, updated_at, "
                    "received_at, next_review) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (s.id, school, s.student_code, s.name, s.grade, s.language, user.id, s.updated_at, received, s.next_review),
                )
            elif s.updated_at >= by_id["updated_at"]:  # last edit wins
                conn.execute(
                    "UPDATE students SET name = ?, grade = ?, language = ?, updated_at = ?, received_at = ?, next_review = ? "
                    "WHERE id = ?",
                    (s.name, s.grade, s.language, s.updated_at, received, s.next_review, target),
                )
            accepted["students"].append(s.id)

        for se in req.sessions:
            student_id = own_student(se.student_id)
            if not student_id:
                rejected.append({"type": "session", "id": se.id, "reason": "unknown student"})
                continue
            conn.execute(
                "INSERT OR REPLACE INTO sessions (id, student_id, teacher_id, school_id, language, grade, placed_level, "
                "needs_help, started_at, finished_at, device_id, received_at, meaning_level, meaning_correct, meaning_total, "
                "meaning_can_say) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (se.id, student_id, user.id, school, se.language, se.grade, se.placed_level, _bool(se.needs_help),
                 se.started_at, se.finished_at, req.device_id, received, se.meaning_level, se.meaning_correct,
                 se.meaning_total, _bool(se.meaning_can_say)),
            )
            accepted["sessions"].append(se.id)

        for a in req.attempts:
            owner = conn.execute("SELECT school_id FROM sessions WHERE id = ?", (a.session_id,)).fetchone()
            if not owner or owner["school_id"] != school:
                rejected.append({"type": "attempt", "id": a.id, "reason": "unknown session"})
                continue
            conn.execute(
                "INSERT OR REPLACE INTO attempts (id, session_id, teacher_id, level, items_json, marks_json, accuracy, passed, "
                "duration_sec, ai_result, created_at, received_at, fluent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (a.id, a.session_id, user.id, a.level, json.dumps(a.items, ensure_ascii=False), json.dumps(a.marks),
                 a.accuracy, int(a.passed), a.duration_sec,
                 json.dumps(a.ai_result, ensure_ascii=False) if a.ai_result else None, a.created_at, received, _bool(a.fluent)),
            )
            accepted["attempts"].append(a.id)

        for p in req.practice:
            student_id = own_student(p.student_id)
            if not student_id:
                rejected.append({"type": "practice", "id": p.id, "reason": "unknown student"})
                continue
            conn.execute(
                "INSERT OR REPLACE INTO practice (id, student_id, teacher_id, school_id, level, correct, total, fluent, passed, "
                "created_at, device_id, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (p.id, student_id, user.id, school, p.level, p.correct, p.total, _bool(p.fluent), int(p.passed),
                 p.created_at, req.device_id, received),
            )
            accepted["practice"].append(p.id)

        for p in req.practice_plans:
            student_id = own_student(p.student_id)
            if not student_id:
                rejected.append({"type": "practice_plan", "id": p.id, "reason": "unknown student"})
                continue
            conn.execute(
                "INSERT OR REPLACE INTO practice_plans (id, student_id, teacher_id, school_id, level, item_count, due_date, "
                "done_at, created_at, device_id, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (p.id, student_id, user.id, school, p.level, p.item_count, p.due_date, p.done_at, p.created_at,
                 req.device_id, received),
            )
            accepted["practice_plans"].append(p.id)

    return {"status": "ok", "accepted": accepted, "student_ids": student_ids, "rejected": rejected, "server_time": received}


# Latest finished check per student, used by the roster and the admin dashboard.
LATEST_SESSION_SQL = """
SELECT st.id, st.student_code, st.name, st.grade, st.language, st.updated_at, st.next_review,
       cu.name AS added_by, se.placed_level, se.needs_help, se.finished_at, tu.name AS last_teacher
FROM students st
LEFT JOIN users cu ON cu.id = st.created_by
LEFT JOIN sessions se ON se.id = (
  SELECT id FROM sessions WHERE student_id = st.id AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1)
LEFT JOIN users tu ON tu.id = se.teacher_id
WHERE st.school_id = ?
ORDER BY st.name COLLATE NOCASE"""


@router.get("/students")
async def school_roster(user: User = Depends(current_user)):
    """Every child in the user's school, so any teacher can assess a child another teacher added."""
    with connect() as conn:
        rows = conn.execute(LATEST_SESSION_SQL, (user.school_id,)).fetchall()
    return {"students": [{**dict(r), "needs_help": None if r["needs_help"] is None else bool(r["needs_help"])} for r in rows]}
