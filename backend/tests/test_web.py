import pytest

from app.config import settings


@pytest.fixture
def web_build():
    root = settings.web_dir
    (root / "_expo").mkdir(parents=True)
    (root / "index.html").write_text("<html>karya</html>")
    (root / "_expo" / "app.js").write_text("console.log(1)")
    (root / "sqlite.wasm").write_bytes(b"\0asm")
    return root


def test_no_web_build_means_404(client):
    assert client.get("/").status_code == 404


def test_serves_index_with_isolation_headers(client, web_build):
    r = client.get("/")
    assert r.text == "<html>karya</html>"
    assert r.headers["cross-origin-opener-policy"] == "same-origin"
    assert r.headers["cross-origin-embedder-policy"] == "require-corp"


def test_deep_links_fall_back_to_index(client, web_build):
    assert client.get("/assess/abc-123").text == "<html>karya</html>"


def test_assets_and_wasm_type(client, web_build):
    assert client.get("/_expo/app.js").text == "console.log(1)"
    assert client.get("/sqlite.wasm").headers["content-type"] == "application/wasm"


def test_api_routes_win_and_unknown_api_is_404(client, web_build):
    assert client.get("/api/health").json()["web_app"] is True
    assert client.get("/api/nope").status_code == 404


def test_cannot_escape_web_folder(client, web_build):
    (settings.web_dir.parent / "secret.txt").write_text("no")
    assert client.get("/..%2Fsecret.txt").text == "<html>karya</html>"
