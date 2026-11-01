from app.db import connect

STUDENT = {"id": "s1", "student_code": "R12", "name": "Lakshmi", "grade": 2, "language": "te", "updated_at": "2026-10-28T10:00:00Z"}
SESSION = {"id": "x1", "student_id": "s1", "language": "te", "grade": 2, "placed_level": 3, "needs_help": False,
           "started_at": "2026-10-28T10:00:00Z", "finished_at": "2026-10-28T10:05:00Z"}
ATTEMPT = {"id": "a1", "session_id": "x1", "level": "sentence", "items": ["ఇది నా పుస్తకం."], "marks": [True, False, True],
           "accuracy": 0.67, "passed": False, "created_at": "2026-10-28T10:01:00Z"}


def payload(**kw):
    return {"device_id": "dev-1", "students": [STUDENT], "sessions": [SESSION], "attempts": [ATTEMPT], **kw}


def test_sync_is_idempotent_and_tags_teacher_and_school(client, school):
    for _ in range(2):
        r = client.post("/api/sync", json=payload())
        assert r.status_code == 200
        assert r.json()["accepted"] == {"students": ["s1"], "sessions": ["x1"], "attempts": ["a1"], "practice": [], "practice_plans": [], "reviews": []}
    with connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 1
        st = conn.execute("SELECT name, school_id, created_by FROM students").fetchone()
        se = conn.execute("SELECT teacher_id, school_id FROM sessions").fetchone()
        at = conn.execute("SELECT marks_json, items_json FROM attempts").fetchone()
    assert (st["name"], st["school_id"], st["created_by"]) == ("Lakshmi", school["school"], school["teacher"])
    assert (se["teacher_id"], se["school_id"]) == (school["teacher"], school["school"])
    assert at["marks_json"] == "[true, false, true]" and "పుస్తకం" in at["items_json"]


def test_body_cannot_choose_school(client, school):
    """School comes from the token; extra fields in the body are ignored."""
    client.post("/api/sync", json=payload(students=[{**STUDENT, "school_id": school["other_school"]}]))
    with connect() as conn:
        assert conn.execute("SELECT school_id FROM students").fetchone()[0] == school["school"]


def test_second_teacher_reuses_student_by_roll_number(client, teacher2):
    client.post("/api/sync", json=payload())
    # Teacher 2 added the same child offline with their own id.
    dup = {**STUDENT, "id": "s1-phone2", "updated_at": "2026-10-29T09:00:00Z"}
    r = teacher2.post("/api/sync", json={"device_id": "dev-2", "students": [dup],
                                         "sessions": [{**SESSION, "id": "x2", "student_id": "s1-phone2"}]})
    body = r.json()
    assert body["student_ids"] == {"s1-phone2": "s1"}
    assert body["accepted"]["sessions"] == ["x2"]
    with connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM students").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM sessions WHERE student_id = 's1'").fetchone()[0] == 2


def test_roster_is_shared_within_school_only(client, teacher2, outsider):
    client.post("/api/sync", json=payload())
    roster = teacher2.get("/api/students").json()["students"]
    assert [s["name"] for s in roster] == ["Lakshmi"]
    assert roster[0]["added_by"] == "Teacher One" and roster[0]["placed_level"] == 3
    assert outsider.get("/api/students").json()["students"] == []


def test_other_school_cannot_write_to_our_students(client, outsider):
    client.post("/api/sync", json=payload())
    r = outsider.post("/api/sync", json={"device_id": "x", "students": [STUDENT],
                                         "sessions": [{**SESSION, "id": "evil"}]}).json()
    assert r["accepted"]["students"] == [] and r["accepted"]["sessions"] == []
    assert {x["type"] for x in r["rejected"]} == {"student", "session"}


def test_last_edit_wins(client):
    client.post("/api/sync", json=payload())
    client.post("/api/sync", json={"device_id": "d", "students": [{**STUDENT, "name": "Old", "updated_at": "2026-01-01T00:00:00Z"}]})
    client.post("/api/sync", json={"device_id": "d", "students": [{**STUDENT, "name": "Lakshmi D", "updated_at": "2026-11-01T00:00:00Z"}]})
    with connect() as conn:
        assert conn.execute("SELECT name FROM students").fetchone()[0] == "Lakshmi D"


# ---- ASER meaning check, fluency, practice and review dates (with accounts) ----

def test_sync_stores_english_meaning_check(client):
    client.post("/api/sync", json=payload())
    session = {"id": "x2", "student_id": "s1", "language": "en", "grade": 3, "placed_level": 3, "needs_help": False,
               "started_at": "t", "finished_at": "t", "meaning_level": "word", "meaning_correct": 4, "meaning_total": 5,
               "meaning_can_say": True}
    assert client.post("/api/sync", json={"device_id": "d", "sessions": [session]}).json()["accepted"]["sessions"] == ["x2"]
    with connect() as conn:
        row = conn.execute("SELECT meaning_level, meaning_correct, meaning_total, meaning_can_say FROM sessions WHERE id = 'x2'").fetchone()
    assert tuple(row) == ("word", 4, 5, 1)


def test_v2_database_gets_new_columns_and_tables():
    """A server database from before practice/meaning (schema v2) is upgraded in place."""
    import sqlite3
    from app.config import settings
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(settings.db_path) as old:
        old.executescript("""
          CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT, student_code TEXT, name TEXT, grade INTEGER,
            language TEXT, created_by TEXT, updated_at TEXT, received_at TEXT);
          CREATE TABLE sessions (id TEXT PRIMARY KEY, student_id TEXT, teacher_id TEXT, school_id TEXT, language TEXT,
            grade INTEGER, placed_level INTEGER, needs_help INTEGER, started_at TEXT, finished_at TEXT, device_id TEXT,
            received_at TEXT);
          CREATE TABLE attempts (id TEXT PRIMARY KEY, session_id TEXT, teacher_id TEXT, level TEXT, items_json TEXT,
            marks_json TEXT, accuracy REAL, passed INTEGER, duration_sec REAL, ai_result TEXT, created_at TEXT, received_at TEXT);
          INSERT INTO students VALUES ('old', 'sch', 'R1', 'Kept', 2, 'hi', NULL, 't', 't');
          PRAGMA user_version = 2;""")
    with connect() as conn:
        assert {"meaning_level", "meaning_can_say"} <= {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
        assert "next_review" in {r[1] for r in conn.execute("PRAGMA table_info(students)")}
        assert "fluent" in {r[1] for r in conn.execute("PRAGMA table_info(attempts)")}
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"practice", "practice_plans"} <= tables
        assert conn.execute("SELECT name FROM students WHERE id = 'old'").fetchone()[0] == "Kept"  # data kept


def test_sync_stores_fluency_judgement(client):
    attempt = {**ATTEMPT, "id": "a9", "level": "paragraph", "accuracy": 0.9, "passed": True, "fluent": True}
    client.post("/api/sync", json=payload(attempts=[attempt]))
    with connect() as conn:
        assert conn.execute("SELECT fluent FROM attempts WHERE id = 'a9'").fetchone()[0] == 1


def test_sync_stores_practice_rounds_and_review_dates(client, school):
    student = {**STUDENT, "next_review": "2026-11-14"}
    practice = {"id": "p1", "student_id": "s1", "level": "word", "correct": 3, "total": 5, "passed": False, "created_at": "t"}
    r = client.post("/api/sync", json={"device_id": "d", "students": [student], "practice": [practice]})
    assert r.status_code == 200 and r.json()["accepted"]["practice"] == ["p1"]
    with connect() as conn:
        assert conn.execute("SELECT next_review FROM students WHERE id = 's1'").fetchone()[0] == "2026-11-14"
        row = conn.execute("SELECT level, correct, total, passed, teacher_id, school_id FROM practice").fetchone()
    assert tuple(row) == ("word", 3, 5, 0, school["teacher"], school["school"])


def test_sync_rejects_a_malformed_review_date(client):
    bad = {"device_id": "d", "students": [{**STUDENT, "next_review": "next week"}]}
    assert client.post("/api/sync", json=bad).status_code == 422


def test_sync_stores_practice_plans_without_items(client):
    plan = {"id": "pl1", "student_id": "s1", "level": "word", "item_count": 3, "due_date": "2026-11-03",
            "done_at": None, "created_at": "t"}
    r = client.post("/api/sync", json={"device_id": "d", "students": [STUDENT], "practice_plans": [plan]})
    assert r.status_code == 200 and r.json()["accepted"]["practice_plans"] == ["pl1"]
    with connect() as conn:
        row = conn.execute("SELECT level, item_count, due_date, done_at FROM practice_plans").fetchone()
        cols = [c[1] for c in conn.execute("PRAGMA table_info(practice_plans)")]
    assert tuple(row) == ("word", 3, "2026-11-03", None)
    assert "items" not in " ".join(cols)


def test_practice_for_another_schools_child_is_rejected(client, outsider):
    client.post("/api/sync", json=payload())
    practice = {"id": "evil-p", "student_id": "s1", "level": "word", "correct": 1, "total": 5, "passed": False, "created_at": "t"}
    plan = {"id": "evil-pl", "student_id": "s1", "level": "word", "item_count": 2, "due_date": "2026-11-03", "created_at": "t"}
    r = outsider.post("/api/sync", json={"device_id": "x", "practice": [practice], "practice_plans": [plan]}).json()
    assert r["accepted"]["practice"] == [] and r["accepted"]["practice_plans"] == []
    with connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM practice").fetchone()[0] == 0


def test_practice_follows_a_merged_student(client, teacher2):
    client.post("/api/sync", json=payload())
    dup = {**STUDENT, "id": "s1-phone2"}
    practice = {"id": "p2", "student_id": "s1-phone2", "level": "letter", "correct": 5, "total": 5, "passed": True, "created_at": "t"}
    r = teacher2.post("/api/sync", json={"device_id": "dev-2", "students": [dup], "practice": [practice]}).json()
    assert r["student_ids"] == {"s1-phone2": "s1"} and r["accepted"]["practice"] == ["p2"]
    with connect() as conn:
        assert conn.execute("SELECT student_id FROM practice WHERE id = 'p2'").fetchone()[0] == "s1"


def test_same_roll_number_in_different_classes_are_different_children(client):
    other_class = {**STUDENT, "id": "s2", "grade": 3, "name": "Ravi"}  # roll R12 again, class 3
    r = client.post("/api/sync", json={"device_id": "d", "students": [STUDENT, other_class]})
    assert r.json()["accepted"]["students"] == ["s1", "s2"] and r.json().get("student_ids", {}) == {}
    with connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM students WHERE student_code = 'R12'").fetchone()[0] == 2


def test_v3_database_gets_roll_unique_per_class_and_keeps_data():
    """Schema v3 made roll numbers unique per school; v4 makes them unique per class. Rows survive."""
    import sqlite3
    from app.config import settings
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(settings.db_path) as old:
        old.executescript("""
          CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT NOT NULL, student_code TEXT NOT NULL,
            name TEXT NOT NULL, grade INTEGER NOT NULL, language TEXT NOT NULL, created_by TEXT,
            updated_at TEXT NOT NULL, received_at TEXT NOT NULL, next_review TEXT, UNIQUE (school_id, student_code));
          CREATE TABLE sessions (id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), teacher_id TEXT,
            school_id TEXT NOT NULL, language TEXT NOT NULL, grade INTEGER NOT NULL, placed_level INTEGER, needs_help INTEGER,
            started_at TEXT NOT NULL, finished_at TEXT, device_id TEXT, received_at TEXT NOT NULL,
            meaning_level TEXT, meaning_correct INTEGER, meaning_total INTEGER, meaning_can_say INTEGER);
          INSERT INTO students VALUES ('a', 'sch', '9', 'Aditya', 3, 'en', NULL, 't', 't', NULL);
          INSERT INTO sessions VALUES ('x', 'a', NULL, 'sch', 'en', 3, 2, 0, 't', 't', NULL, 't', NULL, NULL, NULL, NULL);
          PRAGMA user_version = 3;""")
    with connect() as conn:
        conn.execute("INSERT INTO students (id, school_id, student_code, name, grade, language, updated_at, received_at) "
                     "VALUES ('b', 'sch', '9', 'Sid', 2, 'en', 't', 't')")  # roll 9 in class 2: now allowed
        assert conn.execute("SELECT COUNT(*) FROM students").fetchone()[0] == 2
        assert conn.execute("SELECT student_id FROM sessions WHERE id = 'x'").fetchone()[0] == "a"  # link kept
        try:
            conn.execute("INSERT INTO students (id, school_id, student_code, name, grade, language, updated_at, received_at) "
                         "VALUES ('c', 'sch', '9', 'Dup', 2, 'en', 't', 't')")
            raise AssertionError("same roll in the same class must still be rejected")
        except sqlite3.IntegrityError:
            pass


def test_roster_lists_each_language_a_child_was_checked_in(client):
    english = {**SESSION, "id": "x2", "language": "en", "placed_level": 2, "finished_at": "2026-10-29T10:05:00Z"}
    client.post("/api/sync", json=payload(sessions=[SESSION, english], attempts=[]))
    child = client.get("/api/students").json()["students"][0]
    assert {c["language"]: c["placed_level"] for c in child["checks"]} == {"te": 3, "en": 2}  # one entry, two languages


def test_review_dates_are_per_language_and_last_edit_wins(client):
    review = lambda lang, date, at: {"id": f"s1|{lang}", "student_id": "s1", "language": lang, "next_review": date, "updated_at": at}
    client.post("/api/sync", json=payload(reviews=[review("en", "2026-11-14", "2026-10-30T10:00:00Z"),
                                                    review("te", "2026-11-20", "2026-10-30T10:00:00Z")]))
    client.post("/api/sync", json=payload(reviews=[review("en", "2026-11-01", "2026-10-29T10:00:00Z")]))  # older edit: ignored
    child = client.get("/api/students").json()["students"][0]
    assert {r["language"]: r["next_review"] for r in child["reviews"]} == {"en": "2026-11-14", "te": "2026-11-20"}
