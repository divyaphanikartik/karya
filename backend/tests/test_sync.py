from app.sync import connect

PAYLOAD = {
    "device_id": "dev-1",
    "students": [{"id": "s1", "student_code": "R12", "grade": 2, "language": "te", "updated_at": "2026-10-28T10:00:00Z"}],
    "sessions": [{"id": "x1", "student_id": "s1", "language": "te", "grade": 2, "placed_level": 3, "needs_help": False,
                  "started_at": "2026-10-28T10:00:00Z"}],
    "attempts": [{"id": "a1", "session_id": "x1", "level": "sentence", "accuracy": 0.9, "passed": True,
                  "created_at": "2026-10-28T10:01:00Z"}],
}


def test_sync_is_idempotent(client):
    for _ in range(2):
        r = client.post("/api/sync", json=PAYLOAD)
        assert r.status_code == 200
        assert r.json()["accepted"]["attempts"] == ["a1"]
    with connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 1


def test_sync_never_stores_names(client):
    payload = {"device_id": "d", "students": [{"id": "s1", "name": "Real Child", "grade": 2, "language": "hi", "updated_at": "t"}]}
    client.post("/api/sync", json=payload)
    with connect() as conn:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(students)")]
    assert "name" not in cols


def test_sync_stores_english_meaning_check(client):
    session = {"id": "x2", "student_id": "s1", "language": "en", "grade": 3, "placed_level": 3, "needs_help": False,
               "started_at": "t", "finished_at": "t", "meaning_level": "word", "meaning_correct": 4, "meaning_total": 5,
               "meaning_can_say": True}
    assert client.post("/api/sync", json={"device_id": "d", "sessions": [session]}).status_code == 200
    with connect() as conn:
        row = conn.execute("SELECT meaning_level, meaning_correct, meaning_total, meaning_can_say FROM sessions WHERE id = 'x2'").fetchone()
    assert row == ("word", 4, 5, 1)


def test_sync_adds_meaning_columns_to_an_old_database(client):
    import sqlite3
    from app.config import settings
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(settings.db_path) as old:
        old.execute("DROP TABLE IF EXISTS sessions")
        old.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, device_id TEXT, student_id TEXT, language TEXT, grade INTEGER,"
                    " placed_level INTEGER, needs_help INTEGER, started_at TEXT, finished_at TEXT, received_at TEXT)")
    assert client.post("/api/sync", json=PAYLOAD).status_code == 200
    with connect() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
    assert {"meaning_level", "meaning_can_say"} <= cols


def test_sync_stores_fluency_judgement(client):
    attempt = {"id": "a9", "session_id": "x1", "level": "paragraph", "accuracy": 0.9, "passed": True,
               "created_at": "t", "fluent": True}
    assert client.post("/api/sync", json={"device_id": "d", "attempts": [attempt]}).status_code == 200
    with connect() as conn:
        assert conn.execute("SELECT fluent FROM attempts WHERE id = 'a9'").fetchone() == (1,)


def test_sync_stores_practice_rounds_and_review_dates(client):
    payload = {
        "device_id": "d",
        "students": [{"id": "s7", "grade": 2, "language": "en", "updated_at": "t", "next_review": "2026-11-14"}],
        "practice": [{"id": "p1", "student_id": "s7", "level": "word", "correct": 3, "total": 5, "passed": False,
                      "created_at": "t"}],
    }
    r = client.post("/api/sync", json=payload)
    assert r.status_code == 200 and r.json()["accepted"]["practice"] == ["p1"]
    with connect() as conn:
        assert conn.execute("SELECT next_review FROM students WHERE id = 's7'").fetchone() == ("2026-11-14",)
        assert conn.execute("SELECT level, correct, total, passed FROM practice").fetchone() == ("word", 3, 5, 0)


def test_sync_rejects_a_malformed_review_date(client):
    bad = {"device_id": "d", "students": [{"id": "s8", "grade": 2, "language": "en", "updated_at": "t", "next_review": "next week"}]}
    assert client.post("/api/sync", json=bad).status_code == 422


def test_sync_stores_practice_plans_without_items(client):
    plan = {"id": "pl1", "student_id": "s7", "level": "word", "item_count": 3, "due_date": "2026-11-03",
            "done_at": None, "created_at": "t"}
    r = client.post("/api/sync", json={"device_id": "d", "practice_plans": [plan]})
    assert r.status_code == 200 and r.json()["accepted"]["practice_plans"] == ["pl1"]
    with connect() as conn:
        assert conn.execute("SELECT level, item_count, due_date, done_at FROM practice_plans").fetchone() == ("word", 3, "2026-11-03", None)
        cols = [row[1] for row in conn.execute("PRAGMA table_info(practice_plans)")]
    assert "items" not in " ".join(cols)
