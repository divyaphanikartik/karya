"""Speech-to-text on the server for student recordings (APK and browser alike).

The app uploads a recording; the server decodes it (WAV, WebM/Opus, M4A, ...), runs the language's
offline model (AI4Bharat IndicConformer for Telugu/Hindi, NVIDIA NeMo FastConformer for English, both
via sherpa-onnx), and returns the transcript. The phone then shows the speech model's suggestions next
to the teacher's taps, and the transcript goes to Claude with the taps after sync.

The audio is decoded in memory and discarded; it is never written to disk or kept. Only one model is
loaded at a time (150-250 MB each) so the server fits in small instances.
"""
from __future__ import annotations

import ctypes
import gc
import io
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from .auth import User, current_user
from .config import settings
from .languages import Language
from .speech_models import SPEECH_MODELS

logger = logging.getLogger("karya.transcribe")
router = APIRouter(tags=["speech"])

SAMPLE_RATE = 16000
MAX_UPLOAD_BYTES = 12 * 1024 * 1024  # ~6 min of 16 kHz WAV; WebM is far smaller
MAX_SECONDS = 180
# The model's memory grows steeply with clip length (a 60 s clip needs >512 MB), so long readings are
# cut into pieces of at most CHUNK_SECONDS, at the quietest moment near each cut (children pause
# between sentences), and the pieces' transcripts are joined.
CHUNK_SECONDS = float(os.getenv("KARYA_ASR_CHUNK_SECONDS", "8"))
SEARCH_SECONDS = min(2.0, CHUNK_SECONDS / 3)  # look this far back from a cut for a pause


@dataclass
class _Loaded:
    model_id: str
    recognizer: object


_loaded: _Loaded | None = None
_lock = threading.Lock()  # one decode at a time keeps memory and CPU predictable


def model_for(language: str) -> tuple[str, Path] | None:
    """The installed model folder for a language, or None if it isn't on this server."""
    for model_id, info in SPEECH_MODELS.items():
        folder = Path(settings.speech_models_dir) / model_id
        if info["language"] == language and (folder / "model.int8.onnx").is_file() and (folder / "tokens.txt").is_file():
            return model_id, folder
    return None


def available_languages() -> list[str]:
    return [lang for lang in ("te", "hi", "en") if model_for(lang)]


def decode_audio(data: bytes):
    """Any common recording format -> 16 kHz mono float32 samples (PyAV bundles FFmpeg)."""
    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks = []
    try:
        with av.open(io.BytesIO(data)) as container:
            for frame in container.decode(audio=0):
                chunks.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(frame))
            chunks.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(None))
    except (av.error.FFmpegError, ValueError, IndexError) as exc:
        raise HTTPException(status_code=422, detail="Could not read the recording.") from exc
    if not chunks:
        raise HTTPException(status_code=422, detail="The recording has no audio.")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def split_on_pauses(samples, chunk_seconds: float = CHUNK_SECONDS, search_seconds: float = SEARCH_SECONDS) -> list:
    """Cut audio into pieces of at most chunk_seconds, preferring the quietest 0.2 s near each cut."""
    import numpy as np

    limit = int(chunk_seconds * SAMPLE_RATE)
    if len(samples) <= limit:
        return [samples]
    window = int(0.2 * SAMPLE_RATE)
    search = int(search_seconds * SAMPLE_RATE)
    pieces, start = [], 0
    while len(samples) - start > limit:
        end = start + limit
        lo = max(start + window, end - search)
        region = samples[lo:end]
        # Energy of each 0.2 s window (10 ms hop); cut in the middle of the quietest one.
        energy = np.convolve(region.astype(np.float64) ** 2, np.ones(window), mode="valid")[::160]
        cut = lo + int(np.argmin(energy)) * 160 + window // 2 if len(energy) else end
        pieces.append(samples[start:cut])
        start = cut
    pieces.append(samples[start:])
    return pieces


def _recognizer(model_id: str, folder: Path):
    global _loaded
    if _loaded and _loaded.model_id == model_id:
        return _loaded.recognizer
    import sherpa_onnx

    _loaded = None  # free the previous model before loading the next
    recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
        model=str(folder / "model.int8.onnx"), tokens=str(folder / "tokens.txt"), num_threads=2,
    )
    _loaded = _Loaded(model_id, recognizer)
    return recognizer


def _release_memory() -> None:
    """Return freed memory to the OS after a recording (glibc keeps it otherwise; Linux only)."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass  # not glibc (macOS, Windows): nothing to do


def run_model(model_id: str, folder: Path, samples) -> str:
    import numpy as np

    with _lock:
        recognizer = _recognizer(model_id, folder)
        texts = []
        size = int(CHUNK_SECONDS * SAMPLE_RATE)
        for piece in split_on_pauses(samples):  # bounded memory, however long the reading
            # Pad every piece with silence to the same length: the runtime then reuses one set of
            # buffers instead of caching new ones for each input size (which grows memory without
            # bound). Silence produces no text.
            if len(piece) < size:
                piece = np.pad(piece, (0, size - len(piece)))
            stream = recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, piece)
            recognizer.decode_stream(stream)
            texts.append(stream.result.text.strip())
            del stream
        _release_memory()
        return " ".join(t for t in texts if t)


@router.post("/transcribe")
async def transcribe(
    language: Language = Form(...),
    audio: UploadFile = File(...),
    _user: User = Depends(current_user),
):
    found = model_for(language)
    if not found:
        raise HTTPException(status_code=503, detail="The speech model for this language is not installed on the server.")
    data = await audio.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Recording is too long.")
    samples = await run_in_threadpool(decode_audio, data)
    del data  # the recording is never kept
    seconds = len(samples) / SAMPLE_RATE
    if seconds > MAX_SECONDS:
        raise HTTPException(status_code=413, detail="Recording is too long (3 minutes at most).")
    model_id, folder = found
    started = time.perf_counter()
    text = await run_in_threadpool(run_model, model_id, folder, samples)
    logger.info("Transcribed %.1fs of %s audio in %.2fs", seconds, language, time.perf_counter() - started)
    return {"transcript": text, "model": model_id, "duration_sec": round(seconds, 1)}
