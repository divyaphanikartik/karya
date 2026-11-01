"""Admin dashboard API, scoped to the admin's school: overview, children's histories, teachers."""
from __future__ import annotations

import json
import re
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import User, create_user, hash_password, require_admin
from .db import connect
from .languages import Language
from .sync import latest_session_sql

router = APIRouter(prefix="/admin", tags=["admin"])

_USERNAME = re.compile(r"^[a-zA-Z0-9._-]{3,40}$")


def _school(user: User) -> str:
    if not user.school_id:
        raise HTTPException(status_code=403, detail="Admin account is not linked to a school.")
    return user.school_id


def _student_rows(conn: sqlite3.Connection, school_id: str, language: str | None = None) -> list[dict]:
    """One row per child; with a language, that language's latest check (none shown as not assessed)."""
    rows = conn.execute(latest_session_sql(bool(language)), (language, school_id) if language else (school_id,)).fetchall()
    return [{**dict(r), "needs_help": None if r["needs_help"] is None else bool(r["needs_help"])} for r in rows]


@router.get("/overview")
async def overview(user: User = Depends(require_admin)):
    school_id = _school(user)
    with connect() as conn:
        students = _student_rows(conn, school_id)
        checks = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE school_id = ? AND finished_at IS NOT NULL", (school_id,)).fetchone()[0]
        teachers = conn.execute(
            "SELECT COUNT(*) FROM users WHERE school_id = ? AND role = 'teacher' AND active = 1", (school_id,)).fetchone()[0]
        recent = conn.execute(
            """SELECT se.id, se.finished_at, se.placed_level, se.needs_help, se.language, st.id AS student_id,
                      st.name AS student_name, st.student_code, u.name AS teacher_name
               FROM sessions se JOIN students st ON st.id = se.student_id LEFT JOIN users u ON u.id = se.teacher_id
               WHERE se.school_id = ? AND se.finished_at IS NOT NULL ORDER BY se.finished_at DESC LIMIT 10""",
            (school_id,)).fetchall()
    assessed = [s for s in students if s["placed_level"] is not None]
    # Children per level, per reading language (Teaching-at-the-Right-Level groups).
    levels: dict[str, dict[int, int]] = {}
    for s in assessed:
        by_level = levels.setdefault(s["language"], {})
        by_level[s["placed_level"]] = by_level.get(s["placed_level"], 0) + 1
    return {
        "school": {"name": user.school_name, "code": user.school_code},
        "totals": {
            "students": len(students), "assessed": len(assessed),
            "needs_help": sum(1 for s in assessed if s["needs_help"]), "checks": checks, "teachers": teachers,
        },
        "levels": {lang: [{"placed_level": k, "students": v} for k, v in sorted(counts.items())] for lang, counts in levels.items()},
        "needs_help": [s for s in assessed if s["needs_help"]],
        "recent_checks": [{**dict(r), "needs_help": bool(r["needs_help"])} for r in recent],
    }


@router.get("/students")
async def students(language: Language | None = None, user: User = Depends(require_admin)):
    with connect() as conn:
        return {"students": _student_rows(conn, _school(user), language)}


@router.get("/students/{student_id}")
async def student_detail(student_id: str, user: User = Depends(require_admin)):
    school_id = _school(user)
    with connect() as conn:
        student = conn.execute(
            "SELECT st.*, u.name AS added_by FROM students st LEFT JOIN users u ON u.id = st.created_by "
            "WHERE st.id = ? AND st.school_id = ?", (student_id, school_id)).fetchone()
        if not student:
            raise HTTPException(status_code=404, detail="Student not found in your school.")
        sessions = conn.execute(
            "SELECT se.*, u.name AS teacher_name FROM sessions se LEFT JOIN users u ON u.id = se.teacher_id "
            "WHERE se.student_id = ? ORDER BY se.started_at DESC", (student_id,)).fetchall()
        attempts = conn.execute(
            "SELECT a.* FROM attempts a JOIN sessions se ON se.id = a.session_id WHERE se.student_id = ? ORDER BY a.created_at",
            (student_id,)).fetchall()
    by_session: dict[str, list[dict]] = {}
    for a in attempts:
        items = json.loads(a["items_json"] or "[]")
        marks = json.loads(a["marks_json"] or "[]")
        result = json.loads(a["ai_result"]) if a["ai_result"] else None
        by_session.setdefault(a["session_id"], []).append({
            "id": a["id"], "level": a["level"], "items": items, "accuracy": a["accuracy"], "passed": bool(a["passed"]),
            "duration_sec": a["duration_sec"], "marks": marks,
            "note": result.get("feedback") if result else None,
            "note_source": result.get("feedback_source") if result else None,
            "transcript": result.get("transcript") if result else None,
        })
    return {
        "student": {k: student[k] for k in ("id", "student_code", "name", "grade", "language", "added_by", "updated_at")},
        "sessions": [{
            "id": se["id"], "teacher_name": se["teacher_name"], "language": se["language"], "grade": se["grade"],
            "placed_level": se["placed_level"], "needs_help": None if se["needs_help"] is None else bool(se["needs_help"]),
            "started_at": se["started_at"], "finished_at": se["finished_at"], "attempts": by_session.get(se["id"], []),
        } for se in sessions],
    }


# ---------------------------------------------------------------- teachers

class NewTeacher(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=8, max_length=200)


class TeacherUpdate(BaseModel):
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=200)


@router.get("/teachers")
async def teachers(user: User = Depends(require_admin)):
    school_id = _school(user)
    with connect() as conn:
        rows = conn.execute(
            """SELECT u.id, u.username, u.name, u.active, u.created_at,
                      (SELECT COUNT(*) FROM sessions se WHERE se.teacher_id = u.id AND se.finished_at IS NOT NULL) AS checks,
                      (SELECT MAX(received_at) FROM sessions se WHERE se.teacher_id = u.id) AS last_sync
               FROM users u WHERE u.school_id = ? AND u.role = 'teacher' ORDER BY u.name COLLATE NOCASE""",
            (school_id,)).fetchall()
    return {"teachers": [{**dict(r), "active": bool(r["active"])} for r in rows]}


@router.post("/teachers", status_code=201)
async def add_teacher(req: NewTeacher, user: User = Depends(require_admin)):
    if not _USERNAME.match(req.username):
        raise HTTPException(status_code=422, detail="Username: 3-40 letters, digits, dot, dash or underscore.")
    try:
        teacher_id = create_user(req.username, req.name, "teacher", _school(user), req.password)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="That username is taken.") from None
    return {"id": teacher_id, "username": req.username, "name": req.name, "active": True}


@router.patch("/teachers/{teacher_id}")
async def update_teacher(teacher_id: str, req: TeacherUpdate, user: User = Depends(require_admin)):
    school_id = _school(user)
    with connect() as conn:
        found = conn.execute(
            "SELECT id FROM users WHERE id = ? AND school_id = ? AND role = 'teacher'", (teacher_id, school_id)).fetchone()
        if not found:
            raise HTTPException(status_code=404, detail="Teacher not found in your school.")
        if req.active is not None:
            conn.execute("UPDATE users SET active = ? WHERE id = ?", (int(req.active), teacher_id))
            if not req.active:  # disabling signs the teacher out everywhere
                conn.execute("DELETE FROM auth_tokens WHERE user_id = ?", (teacher_id,))
        if req.password:
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(req.password), teacher_id))
            conn.execute("DELETE FROM auth_tokens WHERE user_id = ?", (teacher_id,))
    return {"status": "updated"}
