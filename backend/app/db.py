"""Server database (SQLite for now). One schema for accounts and the records phones sync."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from .config import settings

SCHEMA_VERSION = 5
_LOCK = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS schools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'admin')), school_id TEXT REFERENCES schools(id),
  password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
-- Students belong to a school, so any teacher there can assess them. Roll number is unique per class
-- (grade) within a school: roll 9 in class 2 and roll 9 in class 3 are different children.
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id), student_code TEXT NOT NULL,
  name TEXT NOT NULL, grade INTEGER NOT NULL, language TEXT NOT NULL, created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL, received_at TEXT NOT NULL, next_review TEXT, UNIQUE (school_id, grade, student_code));
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), teacher_id TEXT REFERENCES users(id),
  school_id TEXT NOT NULL, language TEXT NOT NULL, grade INTEGER NOT NULL, placed_level INTEGER,
  needs_help INTEGER, started_at TEXT NOT NULL, finished_at TEXT, device_id TEXT, received_at TEXT NOT NULL,
  meaning_level TEXT, meaning_correct INTEGER, meaning_total INTEGER, meaning_can_say INTEGER);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), teacher_id TEXT REFERENCES users(id),
  level TEXT NOT NULL, items_json TEXT, marks_json TEXT, accuracy REAL NOT NULL, passed INTEGER NOT NULL,
  duration_sec REAL, ai_result TEXT, created_at TEXT NOT NULL, received_at TEXT NOT NULL, fluent INTEGER);
-- Practice between checks (counts only) and practice moved to a later day (no items).
CREATE TABLE IF NOT EXISTS practice (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), teacher_id TEXT REFERENCES users(id),
  school_id TEXT NOT NULL, level TEXT NOT NULL, correct INTEGER NOT NULL, total INTEGER NOT NULL, fluent INTEGER,
  passed INTEGER NOT NULL, created_at TEXT NOT NULL, device_id TEXT, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS practice_plans (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), teacher_id TEXT REFERENCES users(id),
  school_id TEXT NOT NULL, level TEXT NOT NULL, item_count INTEGER NOT NULL, due_date TEXT NOT NULL, done_at TEXT,
  created_at TEXT NOT NULL, device_id TEXT, received_at TEXT NOT NULL);
-- Next review date of a child in one language (a child is one record, checked in several languages).
CREATE TABLE IF NOT EXISTS reviews (
  student_id TEXT NOT NULL REFERENCES students(id), language TEXT NOT NULL, next_review TEXT NOT NULL,
  updated_at TEXT NOT NULL, teacher_id TEXT REFERENCES users(id), received_at TEXT NOT NULL,
  PRIMARY KEY (student_id, language));
CREATE INDEX IF NOT EXISTS idx_students_school ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_school ON sessions(school_id);
CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_practice_student ON practice(student_id);
CREATE INDEX IF NOT EXISTS idx_practice_plans_student ON practice_plans(student_id);
"""

# Columns added in schema v3 (review dates, ASER meaning check, fluency); added to v2 databases.
_V3_COLUMNS = {
    "students": {"next_review": "TEXT"},
    "sessions": {"meaning_level": "TEXT", "meaning_correct": "INTEGER", "meaning_total": "INTEGER", "meaning_can_say": "INTEGER"},
    "attempts": {"fluent": "INTEGER"},
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _roll_unique_per_grade(conn: sqlite3.Connection) -> None:
    """v3 -> v4: roll numbers were unique per school; they are now unique per class within a school.
    SQLite cannot change a UNIQUE constraint in place, so the students table is rebuilt (SQLite's
    documented way), keeping every row and every id the other tables point at."""
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='students'").fetchone()
    old = "UNIQUE (school_id, student_code)"
    if not row or old not in row[0]:
        return
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")  # lets the old table be dropped while others reference it
    try:
        conn.executescript(
            row[0].replace("CREATE TABLE students", "CREATE TABLE students_new", 1)
            .replace("CREATE TABLE IF NOT EXISTS students", "CREATE TABLE students_new", 1)
            .replace(old, "UNIQUE (school_id, grade, student_code)")
            + ";INSERT INTO students_new SELECT * FROM students;"
            "DROP TABLE students;ALTER TABLE students_new RENAME TO students;"
        )
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def _migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version >= SCHEMA_VERSION:
        return
    # v1 (before accounts) had students/sessions/attempts without school or teacher. Keep that data
    # aside rather than guessing which school it belongs to.
    existing = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "students" in existing:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(students)")}
        if "school_id" not in cols:
            for table in ("students", "sessions", "attempts", "practice", "practice_plans"):
                if table in existing:
                    conn.execute(f"ALTER TABLE {table} RENAME TO legacy_{table}")
            existing = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # v2 -> v3: add the new columns to tables that already exist; CREATE TABLE adds the new tables.
    for table, columns in _V3_COLUMNS.items():
        if table in existing:
            have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            for column, kind in columns.items():
                if column not in have:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
    _roll_unique_per_grade(conn)
    conn.executescript(_SCHEMA)
    if version < 5:  # review dates used to live on the child; they now belong to a language
        conn.execute(
            "INSERT OR IGNORE INTO reviews (student_id, language, next_review, updated_at, received_at) "
            "SELECT id, COALESCE((SELECT language FROM sessions WHERE student_id = students.id AND finished_at IS NOT NULL "
            "ORDER BY finished_at DESC LIMIT 1), language), next_review, updated_at, received_at "
            "FROM students WHERE next_review IS NOT NULL")
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


@contextmanager
def connect():
    """Serialised connection with foreign keys on; commits on success, rolls back on error."""
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        conn = sqlite3.connect(settings.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            _migrate(conn)
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
