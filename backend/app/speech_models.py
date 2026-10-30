"""Offline speech models the phone downloads once (ideally on Wi-Fi) from this server, so the app
never depends on third-party download links. Recognition itself runs on the phone.

Publish the files with:
    python tools/speech_models/download_models.py --lang te hi en --publish backend/data/speech_models
"""
from __future__ import annotations

import hashlib
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from .config import settings

router = APIRouter(tags=["speech models"])

SPEECH_MODEL_FILES = ("model.int8.onnx", "tokens.txt")
SPEECH_MODELS: dict[str, dict[str, str]] = {
    "indicconformer-te": {"language": "te", "engine": "nemo_ctc", "licence": "MIT",
                          "source": "AI4Bharat IndicConformer (Telugu)"},
    "indicconformer-hi": {"language": "hi", "engine": "nemo_ctc", "licence": "MIT",
                          "source": "AI4Bharat IndicConformer (Hindi)"},
    "nemo-fastconformer-en": {"language": "en", "engine": "nemo_ctc", "licence": "CC-BY-4.0",
                              "source": "NVIDIA NeMo FastConformer-CTC (English)"},
}
_SHA_CACHE: dict[tuple[str, float, int], str] = {}


def _sha256(path: str) -> str:
    st = os.stat(path)
    key = (path, st.st_mtime, st.st_size)
    if key not in _SHA_CACHE:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        _SHA_CACHE[key] = h.hexdigest()
    return _SHA_CACHE[key]


@router.get("/speech-models")
async def speech_models(request: Request):
    """Manifest of on-device speech models this server can supply (only fully present ones)."""
    models = []
    for model_id, info in SPEECH_MODELS.items():
        folder = os.path.join(settings.speech_models_dir, model_id)
        paths = [os.path.join(folder, name) for name in SPEECH_MODEL_FILES]
        if not all(os.path.isfile(p) for p in paths):
            continue
        files = [{
            "name": name,
            "url": str(request.url_for("speech_model_file", model_id=model_id, filename=name)),
            "size": os.path.getsize(path),
            "sha256": _sha256(path),
        } for name, path in zip(SPEECH_MODEL_FILES, paths)]
        models.append({"id": model_id, **info, "size_bytes": sum(f["size"] for f in files), "files": files})
    return {"models": models}


@router.get("/speech-models/{model_id}/{filename}", name="speech_model_file")
async def speech_model_file(model_id: str, filename: str):
    # Allow-list both parts so no other server file can be requested.
    if model_id not in SPEECH_MODELS or filename not in SPEECH_MODEL_FILES:
        raise HTTPException(status_code=404, detail="Unknown speech model file.")
    path = os.path.join(settings.speech_models_dir, model_id, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Speech model not published on this server.")
    return FileResponse(path, media_type="application/octet-stream", filename=filename)
