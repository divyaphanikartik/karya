"""Settings read from the environment (and backend/.env). Tests override fields on `settings`."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


@dataclass
class Settings:
    claude_api_key: str
    claude_model: str
    anthropic_version: str
    rate_limit_per_minute: int
    data_dir: Path
    speech_models_dir: Path
    web_dir: Path

    @property
    def pack_dir(self) -> Path:
        return self.data_dir / "content_packs"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "karya.db"

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = Path(os.getenv("KARYA_DATA_DIR", BACKEND_DIR / "data"))
        return cls(
            claude_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip(),
            claude_model=os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5").strip(),
            anthropic_version=os.getenv("ANTHROPIC_VERSION", "2023-06-01"),
            rate_limit_per_minute=int(os.getenv("KARYA_RATE_LIMIT_PER_MINUTE", "12")),
            data_dir=data_dir,
            speech_models_dir=Path(os.getenv("KARYA_SPEECH_MODELS_DIR", data_dir / "speech_models")),
            web_dir=Path(os.getenv("KARYA_WEB_DIR", BACKEND_DIR / "web")),
        )


settings = Settings.from_env()
