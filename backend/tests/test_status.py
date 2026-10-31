import base64

import pytest

from app.status import level_name
from test_sync import payload


def basic(username, password="Password1!"):
    return {"Authorization": "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()}


def test_browser_is_asked_to_sign_in(anon):
    r = anon.get("/api/status")
    assert r.status_code == 401
    assert r.headers["www-authenticate"].startswith("Basic")


def test_wrong_password_prompts_again(anon, school):
    r = anon.get("/api/status", headers=basic("teacher1", "nope"))
    assert r.status_code == 401 and r.headers["www-authenticate"].startswith("Basic")


def test_teacher2_sees_child_synced_by_teacher1(client, anon):
    client.post("/api/sync", json=payload(sessions=[{**payload()["sessions"][0], "placed_level": 1, "needs_help": True}]))
    page = anon.get("/api/status", headers=basic("teacher2"))
    assert page.status_code == 200 and "text/html" in page.headers["content-type"]
    assert "Viewing as <b>Teacher Two</b>" in page.text
    assert "Lakshmi" in page.text and "Needs help" in page.text and "Letter" in page.text
    data = anon.get("/api/status?format=json", headers=basic("teacher2")).json()
    child = data["children"][0]
    assert child == {
        "roll_no": "R12", "name": "Lakshmi", "class": 2, "language": "Telugu", "level": "Letter", "needs_help": True,
        "last_checked": "2026-10-28T10:05:00Z", "last_checked_by": "Teacher One", "checks": 1, "added_by": "Teacher One",
    }


def test_admin_view_and_other_school_isolation(client, anon):
    client.post("/api/sync", json=payload())
    assert anon.get("/api/status?format=json", headers=basic("admin")).json()["viewer"]["role"] == "admin"
    assert anon.get("/api/status?format=json", headers=basic("outsider")).json()["children"] == []


def test_names_are_html_escaped(client, anon):
    evil = {**payload()["students"][0], "name": "<script>x</script>"}
    client.post("/api/sync", json={"device_id": "d", "students": [evil]})
    page = anon.get("/api/status", headers=basic("teacher1")).text
    assert "<script>x</script>" not in page and "&lt;script&gt;" in page


@pytest.mark.parametrize("language,placed,name", [
    ("te", 0, "Beginner"), ("te", 1, "Letter"), ("te", 3, "Paragraph"), ("hi", 4, "Story"), ("hi", 9, "Level 9"),
    ("en", 1, "Capital letters"), ("en", 2, "Small letters"), ("en", 4, "Sentence"), ("hi", None, None),
])
def test_level_names(language, placed, name):
    assert level_name(language, placed) == name
