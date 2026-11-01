import io
import math
import struct
import wave

import pytest

from app import transcribe


def wav_bytes(seconds=1.0, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = (int(8000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(int(seconds * rate)))
        w.writeframes(b"".join(struct.pack("<h", f) for f in frames))
    return buf.getvalue()


@pytest.fixture
def fake_model(monkeypatch, tmp_path):
    """Pretend a Hindi model is installed and record what the model was given."""
    calls = []
    monkeypatch.setattr(transcribe, "model_for", lambda lang: ("indicconformer-hi", tmp_path) if lang == "hi" else None)

    def run(model_id, folder, samples):
        calls.append((model_id, len(samples)))
        return "राम घर गया"

    monkeypatch.setattr(transcribe, "run_model", run)
    return calls


def post(client, language="hi", data=None, mime="audio/wav"):
    return client.post("/api/transcribe", data={"language": language},
                       files={"audio": ("rec.wav", data if data is not None else wav_bytes(), mime)})


def test_needs_sign_in(anon, fake_model):
    assert post(anon).status_code == 401


def test_transcribes_and_decodes_to_16k(client, fake_model):
    r = post(client)
    assert r.status_code == 200
    assert r.json() == {"transcript": "राम घर गया", "model": "indicconformer-hi", "duration_sec": 1.0}
    assert fake_model == [("indicconformer-hi", 16000)]  # 1 s resampled to 16 kHz mono


def test_other_sample_rates_are_resampled(client, fake_model):
    assert post(client, data=wav_bytes(seconds=0.5, rate=48000)).json()["duration_sec"] == 0.5
    assert fake_model[-1][1] == 8000


def test_language_without_model_is_503(client, fake_model):
    assert post(client, language="te").status_code == 503


def test_unreadable_audio_is_422(client, fake_model):
    assert post(client, data=b"definitely not audio").status_code == 422
    assert fake_model == []


def test_too_long_is_rejected(client, fake_model, monkeypatch):
    monkeypatch.setattr(transcribe, "MAX_SECONDS", 0.5)
    assert post(client).status_code == 413


def test_health_lists_speech_languages(client, monkeypatch):
    monkeypatch.setattr(transcribe, "model_for", lambda lang: ("m", None) if lang in ("hi", "en") else None)
    assert client.get("/api/health").json()["speech_languages"] == ["hi", "en"]


def test_long_audio_is_cut_at_a_pause():
    import numpy as np
    sr = transcribe.SAMPLE_RATE
    tone = lambda sec: (0.3 * np.sin(np.arange(int(sec * sr)) * 2 * np.pi * 220 / sr)).astype(np.float32)  # noqa: E731
    # 13 s of "speech", a 0.5 s pause, then 10 s more: the cut must land inside the pause.
    audio = np.concatenate([tone(13), np.zeros(int(0.5 * sr), np.float32), tone(10)])
    pieces = transcribe.split_on_pauses(audio, chunk_seconds=15, search_seconds=3)
    assert len(pieces) == 2
    assert 13 * sr <= len(pieces[0]) <= 13.5 * sr
    assert sum(len(p) for p in pieces) == len(audio)  # nothing lost


def test_short_audio_is_one_piece():
    import numpy as np
    assert len(transcribe.split_on_pauses(np.zeros(16000 * 5, np.float32))) == 1


def test_every_piece_is_bounded():
    import numpy as np
    pieces = transcribe.split_on_pauses(np.random.default_rng(0).normal(0, 0.1, 16000 * 70).astype(np.float32), chunk_seconds=15)
    assert all(len(p) <= 15 * 16000 for p in pieces) and len(pieces) >= 5  # default call uses CHUNK_SECONDS
