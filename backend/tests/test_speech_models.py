import hashlib

from app.config import settings


def publish(model_id, files=("model.int8.onnx", "tokens.txt")):
    folder = settings.speech_models_dir / model_id
    folder.mkdir(parents=True)
    for name in files:
        (folder / name).write_bytes(b"x" * 10)


def test_manifest_lists_only_complete_models(client):
    publish("indicconformer-te")
    publish("indicconformer-hi", files=("model.int8.onnx",))  # incomplete
    models = client.get("/api/speech-models").json()["models"]
    assert [m["id"] for m in models] == ["indicconformer-te"]
    te = models[0]
    assert te["language"] == "te" and te["size_bytes"] == 20
    assert te["files"][0]["sha256"] == hashlib.sha256(b"x" * 10).hexdigest()
    r = client.get(te["files"][0]["url"].replace("http://testserver", ""))
    assert r.status_code == 200 and r.content == b"x" * 10


def test_file_route_allow_list(client):
    publish("indicconformer-te")
    assert client.get("/api/speech-models/indicconformer-te/..%2F..%2Fapp.py").status_code == 404
    assert client.get("/api/speech-models/unknown/model.int8.onnx").status_code == 404
    assert client.get("/api/speech-models/nemo-fastconformer-en/model.int8.onnx").status_code == 404  # not published
