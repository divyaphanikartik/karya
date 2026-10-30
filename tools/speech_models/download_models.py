"""Download Karya's on-device speech models into ./models/<id>/ (cross-platform).

Usage:
    python download_models.py                 # list models
    python download_models.py --lang hi te    # download every model for these languages
    python download_models.py indicconformer-te   # download specific model ids
    python download_models.py --lang te hi en --publish ../../backend/data/speech_models
                                              # also copy them where the Karya server serves them
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS_DIR = HERE / "models"


def registry() -> list[dict]:
    return json.loads((HERE / "models.json").read_text(encoding="utf-8"))["models"]


def _fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "karya-speech-models"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {dest.name}: {done / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    tmp.replace(dest)


def download(model: dict) -> Path:
    target = MODELS_DIR / model["id"]
    if (target / ".complete").exists():
        print(f"✓ {model['id']} already downloaded")
        return target
    print(f"↓ {model['id']} (~{model['size_mb']} MB)")
    target.mkdir(parents=True, exist_ok=True)
    if "archive" in model:
        url = model["archive"]
        apath = target / ("archive.tar.bz2" if url.endswith(".tar.bz2") else "archive.zip")
        _fetch(url, apath)
        if apath.name.endswith(".tar.bz2"):
            with tarfile.open(apath, "r:bz2") as tf:
                tf.extractall(target, filter="data")  # "data" filter blocks path traversal
        else:
            with zipfile.ZipFile(apath) as zf:
                zf.extractall(target)
        apath.unlink()
        # Archives contain one top-level folder; flatten it so the model sits at models/<id>/.
        inner = [p for p in target.iterdir() if p.is_dir()]
        if len(inner) == 1:
            for child in inner[0].iterdir():
                shutil.move(str(child), target / child.name)
            inner[0].rmdir()
    for name, url in model.get("files", {}).items():
        _fetch(url, target / name)
    (target / ".complete").write_text("ok", encoding="utf-8")
    return target


PUBLISHED_FILES = ("model.int8.onnx", "tokens.txt")


def publish(model: dict, dest_root: Path) -> None:
    """Copy the two runtime files into the server's speech-model folder."""
    src, dest = MODELS_DIR / model["id"], dest_root / model["id"]
    dest.mkdir(parents=True, exist_ok=True)
    for name in PUBLISHED_FILES:
        target = dest / name
        if target.exists():
            target.unlink()
        try:
            target.hardlink_to(src / name)  # no extra disk space when on the same drive
        except OSError:
            shutil.copy2(src / name, target)
    print(f"→ published {model['id']} to {dest}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*", help="model ids from models.json")
    ap.add_argument("--lang", nargs="*", choices=["hi", "te", "en"], help="download all models for these languages")
    ap.add_argument("--publish", type=Path, help="copy downloaded models into this folder (the server's KARYA_SPEECH_MODELS_DIR)")
    args = ap.parse_args()
    models = registry()
    chosen = [m for m in models if m["id"] in args.ids or (args.lang and m["language"] in args.lang)]
    if not chosen:
        print("Available models:")
        for m in models:
            print(f"  {m['id']:<22} {m['language']}  ~{m['size_mb']:>4} MB  {m['note']}")
        print("\nExample: python download_models.py --lang te hi en")
        return 0
    unknown = set(args.ids) - {m["id"] for m in models}
    if unknown:
        print(f"Unknown model ids: {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    for m in chosen:
        download(m)
        if args.publish:
            publish(m, args.publish)
    return 0


if __name__ == "__main__":
    sys.exit(main())
