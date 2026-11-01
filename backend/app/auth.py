"""Accounts, sign-in and roles.

Roles: `teacher` runs reading checks and syncs; `admin` sees the school dashboard and manages
teachers. Children are records, not users. Sign-in returns a long-lived bearer token so a teacher
can keep working offline after signing in once; only a hash of the token is stored.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .config import settings
from .db import connect, now

logger = logging.getLogger("karya.auth")
router = APIRouter(prefix="/auth", tags=["auth"])

Role = Literal["teacher", "admin"]
_PBKDF2_ROUNDS = 200_000


# ---------------------------------------------------------------- passwords & tokens

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, rounds, salt, digest = stored.split("$")
    except ValueError:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds))
    return hmac.compare_digest(candidate.hex(), digest)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(frozen=True)
class User:
    id: str
    username: str
    name: str
    role: Role
    school_id: str | None
    school_name: str | None
    school_code: str | None

    def public(self) -> dict:
        return {
            "id": self.id, "username": self.username, "name": self.name, "role": self.role,
            "school": {"id": self.school_id, "name": self.school_name, "code": self.school_code} if self.school_id else None,
        }


_USER_SQL = """
SELECT u.id, u.username, u.name, u.role, u.school_id, s.name AS school_name, s.code AS school_code
FROM users u LEFT JOIN schools s ON s.id = u.school_id"""


def _row_to_user(row) -> User:
    return User(row["id"], row["username"], row["name"], row["role"], row["school_id"], row["school_name"], row["school_code"])


def issue_token(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(days=settings.token_days)).isoformat()
    with connect() as conn:
        conn.execute("INSERT INTO auth_tokens VALUES (?,?,?,?)", (_token_hash(token), user_id, now(), expires))
    return token


def current_user(request: Request) -> User:
    """FastAPI dependency: the signed-in, active user from `Authorization: Bearer <token>`."""
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Sign in required.", headers={"WWW-Authenticate": "Bearer"})
    with connect() as conn:
        row = conn.execute(
            _USER_SQL + " JOIN auth_tokens t ON t.user_id = u.id WHERE t.token_hash = ? AND t.expires_at > ? AND u.active = 1",
            (_token_hash(token), now()),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Session expired or account disabled. Sign in again.",
                            headers={"WWW-Authenticate": "Bearer"})
    return _row_to_user(row)


def require_teacher(user: User = Depends(current_user)) -> User:
    if user.role != "teacher" or not user.school_id:
        raise HTTPException(status_code=403, detail="Teacher account required.")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin account required.")
    return user


# ---------------------------------------------------------------- user management helpers

def create_user(username: str, name: str, role: Role, school_id: str | None, password: str) -> str:
    user_id = str(uuid.uuid4())
    with connect() as conn:
        conn.execute(
            "INSERT INTO users (id, username, name, role, school_id, password_hash, active, created_at) VALUES (?,?,?,?,?,?,1,?)",
            (user_id, username.strip(), name.strip(), role, school_id, hash_password(password), now()),
        )
    return user_id


def create_school(name: str, code: str) -> str:
    school_id = str(uuid.uuid4())
    with connect() as conn:
        conn.execute("INSERT INTO schools VALUES (?,?,?,?)", (school_id, name, code, now()))
    return school_id


# Test credentials for judges and demos. Re-created on every start if missing (Render's free disk is
# wiped on redeploy). Never enable KARYA_DEMO_ACCOUNTS on a deployment holding real children's data.
DEMO_SCHOOL = {"name": "Demo Government Primary School", "code": "DEMO-001"}
DEMO_ACCOUNTS = [
    {"username": "admin", "password": "Admin@123", "name": "Head Teacher (Demo)", "role": "admin"},
    {"username": "teacher1", "password": "Teacher@123", "name": "Lakshmi Devi (Demo)", "role": "teacher"},
    {"username": "teacher2", "password": "Teacher@123", "name": "Ravi Kumar (Demo)", "role": "teacher"},
]


def ensure_demo_accounts() -> None:
    if not settings.demo_accounts:
        return
    with connect() as conn:
        row = conn.execute("SELECT id FROM schools WHERE code = ?", (DEMO_SCHOOL["code"],)).fetchone()
        existing = {r["username"].lower() for r in conn.execute("SELECT username FROM users")}
    school_id = row["id"] if row else create_school(DEMO_SCHOOL["name"], DEMO_SCHOOL["code"])
    for acct in DEMO_ACCOUNTS:
        if acct["username"] not in existing:
            create_user(acct["username"], acct["name"], acct["role"], school_id, acct["password"])
    logger.warning("Demo accounts are enabled (KARYA_DEMO_ACCOUNTS=true). Disable them for real deployments.")


def ensure_first_admin() -> None:
    """A new production server has no accounts (demo accounts are off), so nobody could sign in. If the
    KARYA_FIRST_* settings are given, create that school and its admin once. The password comes from the host's
    secret settings; an admin who already exists is left alone (a changed password is never overwritten)."""
    s = settings
    if not (s.first_school_name and s.first_school_code and s.first_admin_username and s.first_admin_password):
        return
    if len(s.first_admin_password) < 8:
        logger.error("KARYA_FIRST_ADMIN_PASSWORD must be at least 8 characters; no first admin was created.")
        return
    with connect() as conn:
        school = conn.execute("SELECT id FROM schools WHERE code = ?", (s.first_school_code,)).fetchone()
        exists = conn.execute("SELECT 1 FROM users WHERE username = ?", (s.first_admin_username,)).fetchone()
    if exists:
        return
    school_id = school["id"] if school else create_school(s.first_school_name, s.first_school_code)
    create_user(s.first_admin_username, s.first_admin_name, "admin", school_id, s.first_admin_password)
    logger.info("Created the first admin %r for school %r.", s.first_admin_username, s.first_school_code)


# ---------------------------------------------------------------- endpoints

class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


def authenticate(username: str, password: str, headers: dict | None = None) -> User:
    """Check a username and password; raises 401 (wrong) or 403 (disabled)."""
    with connect() as conn:
        row = conn.execute(
            _USER_SQL.replace("SELECT u.id", "SELECT u.password_hash, u.active, u.id") + " WHERE u.username = ?",
            (username.strip(),),
        ).fetchone()
    # Same message for unknown user and wrong password, so usernames can't be probed.
    if not row or not verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Wrong username or password.", headers=headers)
    if not row["active"]:
        raise HTTPException(status_code=403, detail="This account is disabled. Ask your admin.")
    return _row_to_user(row)


@router.post("/login")
async def login(req: LoginRequest):
    user = authenticate(req.username, req.password)
    return {"token": issue_token(user.id), "user": user.public(), "expires_in_days": settings.token_days}


@router.get("/me")
async def me(user: User = Depends(current_user)):
    return user.public()


@router.post("/logout")
async def logout(request: Request, user: User = Depends(current_user)):
    token = request.headers["authorization"].partition(" ")[2]
    with connect() as conn:
        conn.execute("DELETE FROM auth_tokens WHERE token_hash = ?", (_token_hash(token),))
    return {"status": "signed_out"}


@router.get("/demo-accounts")
async def demo_accounts():
    """Test credentials for the sign-in screen, only while KARYA_DEMO_ACCOUNTS is on."""
    if not settings.demo_accounts:
        return {"enabled": False, "accounts": []}
    return {"enabled": True, "school": DEMO_SCHOOL["name"],
            "accounts": [{k: a[k] for k in ("username", "password", "name", "role")} for a in DEMO_ACCOUNTS]}
