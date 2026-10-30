"""Idempotent upsert of pseudonymous records from the phone. Student names and audio never arrive here."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone

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


class SyncSession(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    student_id: str = Field(min_length=1, max_length=80)
    language: Language
    grade: int = Field(ge=1, le=5)
    placed_level: int | None = Field(default=None, ge=0, le=4)
    needs_help: bool | None = None
    started_at: str = Field(max_length=48)
    finished_at: str | None = Field(default=None, max_length=48)


class SyncAttempt(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    session_id: str = Field(min_length=1, max_length=80)
    level: Level
    accuracy: float = Field(ge=0, le=1)
    passed: bool
    duration_sec: float | None = Field(default=None, ge=0, le=600)
    ai_result: dict | None = None
    created_at: str = Field(max_length=48)


class SyncRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=80)
    students: list[SyncStudent] = Field(default_factory=list, max_length=500)
    sessions: list[SyncSession] = Field(default_factory=list, max_length=500)
    attempts: list[SyncAttempt] = Field(default_factory=list, max_length=2000)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, device_id TEXT, student_code TEXT, grade INTEGER,
  school_code TEXT, language TEXT, updated_at TEXT, received_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, device_id TEXT, student_id TEXT, language TEXT, grade INTEGER,
  placed_level INTEGER, needs_help INTEGER, started_at TEXT, finished_at TEXT, received_at TEXT);
CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, device_id TEXT, session_id TEXT, level TEXT, accuracy REAL,
  passed INTEGER, duration_sec REAL, ai_result TEXT, created_at TEXT, received_at TEXT);
"""


def connect() -> sqlite3.Connection:
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.db_path)
    conn.executescript(_SCHEMA)
    return conn


@router.post("/sync")
async def sync(req: SyncRequest):
    now = datetime.now(timezone.utc).isoformat()
    with _DB_LOCK, connect() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO students VALUES (?,?,?,?,?,?,?,?)",
            [(s.id, req.device_id, s.student_code, s.grade, s.school_code, s.language, s.updated_at, now) for s in req.students],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(s.id, req.device_id, s.student_id, s.language, s.grade, s.placed_level,
              None if s.needs_help is None else int(s.needs_help), s.started_at, s.finished_at, now) for s in req.sessions],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(a.id, req.device_id, a.session_id, a.level, a.accuracy, int(a.passed), a.duration_sec,
              json.dumps(a.ai_result, ensure_ascii=False) if a.ai_result else None, a.created_at, now) for a in req.attempts],
        )
    return {
        "status": "ok",
        "accepted": {"students": [s.id for s in req.students], "sessions": [s.id for s in req.sessions], "attempts": [a.id for a in req.attempts]},
        "server_time": now,
    }
