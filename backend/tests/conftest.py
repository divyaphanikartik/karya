import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.claude import reset_rate_limit  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    """Demo mode (no Claude key) and a throwaway data folder: tests never call paid APIs."""
    monkeypatch.setattr(settings, "claude_api_key", "")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "speech_models_dir", tmp_path / "speech_models")
    monkeypatch.setattr(settings, "web_dir", tmp_path / "web")
    reset_rate_limit()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def with_claude_key(monkeypatch):
    monkeypatch.setattr(settings, "claude_api_key", "test-key")
