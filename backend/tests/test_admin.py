from test_sync import payload


def test_overview_counts_and_needs_help(client, admin):
    client.post("/api/sync", json=payload(sessions=[{**payload()["sessions"][0], "placed_level": 1, "needs_help": True}]))
    body = admin.get("/api/admin/overview").json()
    assert body["school"]["code"] == "T-001"
    assert body["totals"] == {"students": 1, "assessed": 1, "needs_help": 1, "checks": 1, "teachers": 2}
    assert body["levels"] == {"te": [{"placed_level": 1, "students": 1}]}
    assert body["needs_help"][0]["name"] == "Lakshmi"
    assert body["recent_checks"][0]["teacher_name"] == "Teacher One"


def test_student_detail_shows_missed_words_and_teacher(client, admin):
    client.post("/api/sync", json=payload())
    detail = admin.get("/api/admin/students/s1").json()
    assert detail["student"]["name"] == "Lakshmi" and detail["student"]["added_by"] == "Teacher One"
    attempt = detail["sessions"][0]["attempts"][0]
    assert attempt["marks"] == [True, False, True] and attempt["level"] == "sentence"
    assert detail["sessions"][0]["teacher_name"] == "Teacher One"


def test_admin_cannot_see_other_schools(outsider, admin):
    outsider.post("/api/sync", json=payload())
    assert admin.get("/api/admin/students").json()["students"] == []
    assert admin.get("/api/admin/students/s1").status_code == 404


def test_admin_creates_disables_and_resets_teachers(admin, anon):
    r = admin.post("/api/admin/teachers", json={"name": "New Teacher", "username": "newt", "password": "Welcome@1"})
    assert r.status_code == 201
    new_id = r.json()["id"]
    assert admin.post("/api/admin/teachers", json={"name": "Dup", "username": "NEWT", "password": "Welcome@1"}).status_code == 409
    assert admin.post("/api/admin/teachers", json={"name": "Bad", "username": "a b", "password": "Welcome@1"}).status_code == 422
    login = anon.post("/api/auth/login", json={"username": "newt", "password": "Welcome@1"}).json()
    token = {"Authorization": f"Bearer {login['token']}"}
    assert anon.get("/api/auth/me", headers=token).status_code == 200

    assert admin.patch(f"/api/admin/teachers/{new_id}", json={"active": False}).status_code == 200
    assert anon.get("/api/auth/me", headers=token).status_code == 401  # signed out everywhere
    assert anon.post("/api/auth/login", json={"username": "newt", "password": "Welcome@1"}).status_code == 403

    admin.patch(f"/api/admin/teachers/{new_id}", json={"active": True, "password": "Changed@2"})
    assert anon.post("/api/auth/login", json={"username": "newt", "password": "Changed@2"}).status_code == 200
    names = [t["name"] for t in admin.get("/api/admin/teachers").json()["teachers"]]
    assert names == ["New Teacher", "Teacher One", "Teacher Two"]


def test_admin_cannot_manage_other_schools_teachers(admin, school):
    assert admin.patch(f"/api/admin/teachers/{school['outsider']}", json={"active": False}).status_code == 404
