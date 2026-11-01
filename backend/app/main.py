"""FastAPI entry point: `uvicorn app.main:app` from the backend/ folder."""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response

from . import admin, assess, auth, content, speech_models, status, sync, transcribe, web
from .claude import claude_configured
from .config import settings
from .content import PACK_VERSION
from .languages import LANGUAGE_NAMES
from .speech_models import SPEECH_MODELS

@asynccontextmanager
async def lifespan(_app: FastAPI):
    auth.ensure_demo_accounts()  # creates the database and the test accounts if enabled
    auth.ensure_first_admin()  # a new production server: its first school and admin, from the KARYA_FIRST_* settings
    yield


app = FastAPI(
    lifespan=lifespan,
    title="Karya backend",
    description="Reading word packs, Claude teacher notes, offline speech-model downloads and sync for the Karya mobile app.",
    version="1.0.0",
)

for module in (auth, admin, content, assess, sync, speech_models, status, transcribe):
    app.include_router(module.router, prefix="/api")


# The app's connectivity check and uptime monitors probe with HEAD; a 405 would read as "offline".
@app.head("/api/health", include_in_schema=False)
async def health_head():
    return Response()


@app.get("/api/health", tags=["health"])
async def health():
    return {
        "status": "ok",
        "version": app.version,
        "claude_configured": claude_configured(),
        "claude_model": settings.claude_model if claude_configured() else None,
        "speech_recognition": "server",
        "speech_languages": transcribe.available_languages(),  # languages whose model is installed
        "speech_models": list(SPEECH_MODELS),
        "languages": list(LANGUAGE_NAMES),
        "pack_version": PACK_VERSION,
        "web_app": (settings.web_dir / "index.html").is_file(),
        "demo_accounts": settings.demo_accounts,
    }


# Registered last so every /api route above wins; serves the web app for everything else.
app.middleware("http")(web.add_isolation_headers)
app.include_router(web.router)
