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
