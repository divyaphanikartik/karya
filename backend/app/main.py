"""FastAPI entry point: `uvicorn app.main:app` from the backend/ folder."""
from fastapi import FastAPI

from . import assess, content, speech_models, sync, web
from .claude import claude_configured
from .config import settings
from .content import PACK_VERSION
from .languages import LANGUAGE_NAMES
from .speech_models import SPEECH_MODELS

app = FastAPI(
    title="Karya backend",
    description="Reading word packs, Claude teacher notes, offline speech-model downloads and sync for the Karya mobile app.",
    version="1.0.0",
)

for module in (content, assess, sync, speech_models):
    app.include_router(module.router, prefix="/api")


# HEAD too: the app's connectivity check and uptime monitors probe with HEAD requests.
@app.api_route("/api/health", methods=["GET", "HEAD"], tags=["health"])
async def health():
    return {
        "status": "ok",
        "version": app.version,
        "claude_configured": claude_configured(),
        "claude_model": settings.claude_model if claude_configured() else None,
        "speech_recognition": "on_device",
        "speech_models": list(SPEECH_MODELS),
        "languages": list(LANGUAGE_NAMES),
        "pack_version": PACK_VERSION,
        "web_app": (settings.web_dir / "index.html").is_file(),
    }


# Registered last so every /api route above wins; serves the web app for everything else.
app.middleware("http")(web.add_isolation_headers)
app.include_router(web.router)
