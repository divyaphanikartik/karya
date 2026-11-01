"""GET /api/status: children's assessment status as a given teacher or admin sees it.

Open it in any browser: the browser asks for a username and password (HTTP Basic auth), then shows
a table of every child in that user's school with their latest level. Add ?format=json for JSON.
Meant for checking sync from another user's point of view; use HTTPS on any shared deployment.
"""
from __future__ import annotations

import html
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .auth import User, authenticate
from .claude import enforce_rate_limit
from .db import connect
from .languages import LADDERS, LANGUAGE_NAMES

router = APIRouter(tags=["status"])
_basic = HTTPBasic(realm="Karya", auto_error=False)
_PROMPT = {"WWW-Authenticate": 'Basic realm="Karya"'}

_STATUS_SQL = """
SELECT st.student_code, st.name, st.grade, st.language, cu.name AS added_by,
       se.placed_level, se.needs_help, se.finished_at, tu.name AS last_checked_by,
       (SELECT COUNT(*) FROM sessions WHERE student_id = st.id AND finished_at IS NOT NULL) AS checks
FROM students st
LEFT JOIN users cu ON cu.id = st.created_by
LEFT JOIN sessions se ON se.id = (
  SELECT id FROM sessions WHERE student_id = st.id AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1)
LEFT JOIN users tu ON tu.id = se.teacher_id
WHERE st.school_id = ?
ORDER BY st.grade, st.name COLLATE NOCASE"""

_LEVEL_NAMES = {"capital": "Capital letters", "letter": "Letter", "word": "Word", "sentence": "Sentence",
                "paragraph": "Paragraph", "story": "Story"}


def level_name(language: str, placed: int | None) -> str | None:
    """Placed level (0 = beginner, n = n-th step of the language's ladder) as a readable name."""
    if placed is None:
        return None
    if placed == 0:
        return "Beginner"
    ladder = LADDERS[language]
    if not 1 <= placed <= len(ladder):  # e.g. a record saved on an older ladder
        return f"Level {placed}"
    step = ladder[placed - 1]
    return "Small letters" if language == "en" and step == "letter" else _LEVEL_NAMES[step]


def _user(request_credentials: HTTPBasicCredentials | None) -> User:
    if request_credentials is None:
        raise HTTPException(status_code=401, detail="Sign in with your Karya username and password.", headers=_PROMPT)
    return authenticate(request_credentials.username, request_credentials.password, headers=_PROMPT)


@router.get("/status", response_model=None)
async def assessment_status(
    format: Literal["html", "json"] = "html",  # noqa: A002 - public query parameter name
    credentials: HTTPBasicCredentials | None = Depends(_basic),
    _limit: None = Depends(enforce_rate_limit),  # slows password guessing on a public URL
):
    user = _user(credentials)
    if not user.school_id:
        raise HTTPException(status_code=403, detail="This account is not linked to a school.")
    with connect() as conn:
        rows = conn.execute(_STATUS_SQL, (user.school_id,)).fetchall()
    children = [{
        "roll_no": r["student_code"], "name": r["name"], "class": r["grade"], "language": LANGUAGE_NAMES[r["language"]],
        "level": level_name(r["language"], r["placed_level"]),
        "needs_help": None if r["needs_help"] is None else bool(r["needs_help"]),
        "last_checked": r["finished_at"], "last_checked_by": r["last_checked_by"], "checks": r["checks"],
        "added_by": r["added_by"],
    } for r in rows]
    viewer = {"name": user.name, "username": user.username, "role": user.role, "school": user.school_name}
    if format == "json":
        return {"viewer": viewer, "children": children}
    return HTMLResponse(_render(viewer, children))


def _render(viewer: dict, children: list[dict]) -> str:
    e = lambda v: html.escape("" if v is None else str(v))  # noqa: E731
    assessed = [c for c in children if c["level"]]
    rows = "".join(
        f"<tr><td>{e(c['roll_no'])}</td><td>{e(c['name'])}</td><td>{e(c['class'])}</td><td>{e(c['language'])}</td>"
        f"<td>{e(c['level'] or 'Not assessed')}</td>"
        f"<td class='{'help' if c['needs_help'] else 'ok' if c['needs_help'] is False else ''}'>"
        f"{'Needs help' if c['needs_help'] else 'On track' if c['needs_help'] is False else ''}</td>"
        f"<td>{e((c['last_checked'] or '')[:16].replace('T', ' '))}</td><td>{e(c['last_checked_by'])}</td>"
        f"<td>{e(c['checks'])}</td><td>{e(c['added_by'])}</td></tr>"
        for c in children)
    return f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Karya status</title>
<style>body{{font:15px system-ui,"Noto Sans Devanagari","Noto Sans Telugu",sans-serif;margin:20px;color:#1b1b1b}}
table{{border-collapse:collapse;width:100%}}th,td{{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}}
th{{background:#f3f1ec}}.help{{color:#b3261e;font-weight:700}}.ok{{color:#1e7b3a}}.muted{{color:#666;font-size:13px}}</style>
<h2>Children's assessment status</h2>
<p>Viewing as <b>{e(viewer['name'])}</b> ({e(viewer['username'])}, {e(viewer['role'])}) · {e(viewer['school'])}<br>
{len(children)} children · {len(assessed)} assessed · {sum(1 for c in assessed if c['needs_help'])} need help</p>
<table><tr><th>Roll no.</th><th>Name</th><th>Grade</th><th>Language</th><th>Latest level</th><th>Status</th>
<th>Last checked (UTC)</th><th>By</th><th>Checks</th><th>Added by</th></tr>{rows or '<tr><td colspan=10>No children synced yet.</td></tr>'}</table>
<p class="muted">Shows only what has synced to this server. Checks still waiting on a phone appear after it syncs.
JSON: add <code>?format=json</code>. To view as another user, open this page in a private window.</p>"""
