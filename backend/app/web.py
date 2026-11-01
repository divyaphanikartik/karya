"""Serves the exported Expo web app (if present) so one deployed URL hosts both the app and the API.

Build it with `npx expo export --platform web --output-dir ../backend/web` from mobile/ (the root
Dockerfile does this). expo-sqlite on web needs SharedArrayBuffer, which browsers only allow on
cross-origin-isolated pages, hence the COOP/COEP headers on every response.
"""
from __future__ import annotations

import mimetypes

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from .config import settings

mimetypes.add_type("application/wasm", ".wasm")
router = APIRouter(include_in_schema=False)

ISOLATION_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}


async def add_isolation_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.update(ISOLATION_HEADERS)
    return response


@router.get("/{path:path}")
async def web_app(path: str):
    root = settings.web_dir.resolve()
    index = root / "index.html"
    if path.startswith("api/") or not index.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    candidate = (root / path).resolve()
    if path and candidate.is_file() and root in candidate.parents:
        # The service worker and its file list must never be served stale, or a new deploy would not reach browsers.
        headers = {"Cache-Control": "no-cache"} if path in ("sw.js", "precache.json") else None
        return FileResponse(candidate, headers=headers)
    # Single-page app: unknown paths (e.g. /assess/123) load index.html and the router takes over.
    return FileResponse(index, headers={"Cache-Control": "no-cache"})
