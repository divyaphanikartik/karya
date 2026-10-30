def test_health_reports_demo_mode(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["claude_configured"] is False and body["claude_model"] is None
    assert body["speech_recognition"] == "on_device"
    assert body["languages"] == ["en", "hi", "te"]


def test_only_mobile_api_is_exposed(client):
    paths = set(client.get("/openapi.json").json()["paths"])  # the web-app catch-all is hidden from the schema
    assert paths == {
        "/api/health", "/api/content-pack", "/api/assess-reading", "/api/sync",
        "/api/speech-models", "/api/speech-models/{model_id}/{filename}",
    }


def test_health_answers_head_requests(client):
    """The mobile app's connectivity check uses HEAD; a 405 would make it think it's offline."""
    assert client.head("/api/health").status_code == 200
