import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import create_school, create_user, issue_token  # noqa: E402
from app.claude import reset_rate_limit  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    """Demo mode (no Claude key), a throwaway data folder and no demo accounts: never calls paid APIs."""
    monkeypatch.setattr(settings, "claude_api_key", "")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "speech_models_dir", tmp_path / "speech_models")
    monkeypatch.setattr(settings, "web_dir", tmp_path / "web")
    monkeypatch.setattr(settings, "demo_accounts", False)
    reset_rate_limit()


@pytest.fixture
def school():
    """One school with two teachers and an admin, plus a teacher at another school."""
    school_id = create_school("Test School", "T-001")
    other_id = create_school("Other School", "O-001")
    ids = {
        "school": school_id, "other_school": other_id,
        "teacher": create_user("teacher1", "Teacher One", "teacher", school_id, "Password1!"),
        "teacher2": create_user("teacher2", "Teacher Two", "teacher", school_id, "Password1!"),
        "admin": create_user("admin", "Head Teacher", "admin", school_id, "Password1!"),
        "outsider": create_user("outsider", "Other Teacher", "teacher", other_id, "Password1!"),
    }
    return ids


def _client_as(user_id=None) -> TestClient:
    c = TestClient(app)
    if user_id:
        c.headers["Authorization"] = f"Bearer {issue_token(user_id)}"
    return c


@pytest.fixture
def anon():
    return _client_as()


@pytest.fixture
def client(school):
    """Signed in as teacher1 (most endpoints need a signed-in user)."""
    return _client_as(school["teacher"])


@pytest.fixture
def teacher2(school):
    return _client_as(school["teacher2"])


@pytest.fixture
def admin(school):
    return _client_as(school["admin"])


@pytest.fixture
def outsider(school):
    return _client_as(school["outsider"])


@pytest.fixture
def with_claude_key(monkeypatch):
    monkeypatch.setattr(settings, "claude_api_key", "test-key")
