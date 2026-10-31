from app import auth
from app.config import settings


def test_password_hashing_round_trip():
    stored = auth.hash_password("s3cret!")
    assert stored.startswith("pbkdf2_sha256$") and "s3cret" not in stored
    assert auth.verify_password("s3cret!", stored)
    assert not auth.verify_password("wrong", stored)


def test_login_returns_token_and_role(anon, school):
    r = anon.post("/api/auth/login", json={"username": "TEACHER1", "password": "Password1!"})  # username is case-insensitive
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["role"] == "teacher" and body["user"]["school"]["code"] == "T-001"
    me = anon.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.json()["username"] == "teacher1"


def test_wrong_password_and_unknown_user_look_the_same(anon, school):
    a = anon.post("/api/auth/login", json={"username": "teacher1", "password": "nope"})
    b = anon.post("/api/auth/login", json={"username": "ghost", "password": "nope"})
    assert a.status_code == b.status_code == 401 and a.json() == b.json()


def test_protected_endpoints_need_sign_in(anon):
    assert anon.post("/api/sync", json={"device_id": "d"}).status_code == 401
    assert anon.get("/api/students").status_code == 401
    assert anon.get("/api/content-pack?language=hi&grade=2").status_code == 401
    assert anon.get("/api/admin/overview").status_code == 401
    assert anon.get("/api/auth/me", headers={"Authorization": "Bearer made-up"}).status_code == 401


def test_logout_revokes_token(client):
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401


def test_roles_are_enforced(client, admin):
    assert client.get("/api/admin/overview").status_code == 403  # teacher -> admin API
    assert admin.post("/api/sync", json={"device_id": "d"}).status_code == 403  # admin doesn't sync checks


def test_demo_accounts_created_once_and_listed(anon, monkeypatch):
    monkeypatch.setattr(settings, "demo_accounts", True)
    auth.ensure_demo_accounts()
    auth.ensure_demo_accounts()  # idempotent
    listed = anon.get("/api/auth/demo-accounts").json()
    assert listed["enabled"] and {a["username"] for a in listed["accounts"]} == {"admin", "teacher1", "teacher2"}
    for acct in listed["accounts"]:
        r = anon.post("/api/auth/login", json={"username": acct["username"], "password": acct["password"]})
        assert r.json()["user"]["role"] == acct["role"]


def test_demo_accounts_hidden_when_disabled(anon):
    assert anon.get("/api/auth/demo-accounts").json() == {"enabled": False, "accounts": []}
