"""Idempotent upsert of pseudonymous records from the phone. Student names and audio never arrive here."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .config import settings
from .languages import Language, Level

router = APIRouter(tags=["sync"])
_DB_LOCK = threading.Lock()


class SyncStudent(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    student_code: str = Field(default="", max_length=40)
    grade: int = Field(ge=1, le=5)
    school_code: str = Field(default="", max_length=60)
    language: Language
    updated_at: str = Field(max_length=48)
    next_review: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")  # the teacher's review date


class SyncPractice(BaseModel):
    """One practice round between checks: counts only, like attempts."""
    id: str = Field(min_length=1, max_length=80)
    student_id: str = Field(min_length=1, max_length=80)
    level: Level
    correct: int = Field(ge=0, le=200)
    total: int = Field(ge=1, le=200)
    fluent: bool | None = None
    passed: bool
    created_at: str = Field(max_length=48)


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
    accuracy: float = Field(ge=0, le=1)
    passed: bool
    duration_sec: float | None = Field(default=None, ge=0, le=600)
    ai_result: dict | None = None
    created_at: str = Field(max_length=48)
    fluent: bool | None = None  # paragraph/story: the teacher's ASER fluency judgement


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


_SCHEMA = """
CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, device_id TEXT, student_code TEXT, grade INTEGER,
  school_code TEXT, language TEXT, updated_at TEXT, received_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, device_id TEXT, student_id TEXT, language TEXT, grade INTEGER,
  placed_level INTEGER, needs_help INTEGER, started_at TEXT, finished_at TEXT, received_at TEXT);
CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, device_id TEXT, session_id TEXT, level TEXT, accuracy REAL,
  passed INTEGER, duration_sec REAL, ai_result TEXT, created_at TEXT, received_at TEXT);
CREATE TABLE IF NOT EXISTS practice (id TEXT PRIMARY KEY, device_id TEXT, student_id TEXT, level TEXT, correct INTEGER,
  total INTEGER, fluent INTEGER, passed INTEGER, created_at TEXT, received_at TEXT);
CREATE TABLE IF NOT EXISTS practice_plans (id TEXT PRIMARY KEY, device_id TEXT, student_id TEXT, level TEXT,
  item_count INTEGER, due_date TEXT, done_at TEXT, created_at TEXT, received_at TEXT);
"""
# Columns added after the first release; added to existing databases on connect.
_ADDED_COLUMNS = {
    "students": {"next_review": "TEXT"},
    "sessions": {"meaning_level": "TEXT", "meaning_correct": "INTEGER", "meaning_total": "INTEGER", "meaning_can_say": "INTEGER"},
    "attempts": {"fluent": "INTEGER"},
}


def connect() -> sqlite3.Connection:
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.db_path)
    conn.executescript(_SCHEMA)
    for table, columns in _ADDED_COLUMNS.items():
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for column, kind in columns.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
    return conn


@router.post("/sync")
async def sync(req: SyncRequest):
    now = datetime.now(timezone.utc).isoformat()
    with _DB_LOCK, connect() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO students (id, device_id, student_code, grade, school_code, language, updated_at,
                 received_at, next_review) VALUES (?,?,?,?,?,?,?,?,?)""",
            [(s.id, req.device_id, s.student_code, s.grade, s.school_code, s.language, s.updated_at, now, s.next_review)
             for s in req.students],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO practice VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(p.id, req.device_id, p.student_id, p.level, p.correct, p.total, None if p.fluent is None else int(p.fluent),
              int(p.passed), p.created_at, now) for p in req.practice],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO practice_plans VALUES (?,?,?,?,?,?,?,?,?)",
            [(p.id, req.device_id, p.student_id, p.level, p.item_count, p.due_date, p.done_at, p.created_at, now)
             for p in req.practice_plans],
        )
        conn.executemany(
            """INSERT OR REPLACE INTO sessions (id, device_id, student_id, language, grade, placed_level, needs_help,
                 started_at, finished_at, received_at, meaning_level, meaning_correct, meaning_total, meaning_can_say)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(s.id, req.device_id, s.student_id, s.language, s.grade, s.placed_level,
              None if s.needs_help is None else int(s.needs_help), s.started_at, s.finished_at, now,
              s.meaning_level, s.meaning_correct, s.meaning_total,
              None if s.meaning_can_say is None else int(s.meaning_can_say)) for s in req.sessions],
        )
        conn.executemany(
            """INSERT OR REPLACE INTO attempts (id, device_id, session_id, level, accuracy, passed, duration_sec, ai_result,
                 created_at, received_at, fluent) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            [(a.id, req.device_id, a.session_id, a.level, a.accuracy, int(a.passed), a.duration_sec,
              json.dumps(a.ai_result, ensure_ascii=False) if a.ai_result else None, a.created_at, now,
              None if a.fluent is None else int(a.fluent)) for a in req.attempts],
        )
    return {
        "status": "ok",
        "accepted": {
            "students": [s.id for s in req.students], "sessions": [s.id for s in req.sessions],
            "attempts": [a.id for a in req.attempts], "practice": [p.id for p in req.practice],
            "practice_plans": [p.id for p in req.practice_plans],
        },
        "server_time": now,
    }
