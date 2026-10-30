"""Claude Messages API calls with structured JSON output, plus a small per-IP rate limit."""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict, deque

import httpx
from fastapi import HTTPException, Request

from .config import settings

logger = logging.getLogger("karya.claude")
_RATE_WINDOW: dict[str, deque[float]] = defaultdict(deque)
_RATE_LOCK = threading.Lock()


def claude_configured() -> bool:
    return bool(settings.claude_api_key)


def enforce_rate_limit(request: Request) -> None:
    """Process-local limit so a public demo URL can't drain Claude credits."""
    host = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _RATE_LOCK:
        events = _RATE_WINDOW[host]
        while events and now - events[0] > 60:
            events.popleft()
        if len(events) >= max(1, settings.rate_limit_per_minute):
            raise HTTPException(status_code=429, detail="Request limit reached. Wait one minute and try again.")
        events.append(now)


def reset_rate_limit() -> None:
    with _RATE_LOCK:
        _RATE_WINDOW.clear()


async def claude_json(system: str, user: str, schema: dict, max_tokens: int) -> dict:
    """Call Claude and return the JSON object matching `schema` (raises on HTTP or parse errors)."""
    body = {
        "model": settings.claude_model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "output_config": {"format": {"type": "json_schema", "schema": schema}},
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        response = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": settings.claude_api_key, "anthropic-version": settings.anthropic_version,
                     "content-type": "application/json"},
            json=body,
        )
        if response.is_error:
            # Log only the provider's error type/message, never headers or the request body.
            try:
                err = response.json().get("error", {})
            except ValueError:
                err = {}
            logger.warning("Claude API rejected request: HTTP %s; %s: %s", response.status_code,
                           str(err.get("type", ""))[:120], str(err.get("message", ""))[:300])
        response.raise_for_status()
    data = response.json()
    if data.get("stop_reason") == "max_tokens":
        raise ValueError("Claude output truncated at max_tokens")
    text = "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")
    return json.loads(text)
