"""Validate Karya's on-device speech models on real reading recordings (cross-platform).

For every recording listed in a CSV, each downloaded model for that language transcribes it.
The report answers the questions that matter for Karya:
  1. Accuracy  - character error rate (CER) against what the child actually said.
  2. Mistakes  - when the child misread, did the model KEEP the mistake or AUTOCORRECT it
                 to the expected word (which would hide the error from the teacher)?
  3. Speed     - real-time factor (processing time / audio length) on this machine.

Usage:
    python validate.py --samples samples/phone/samples.csv
    python validate.py --samples samples/samples.csv --models indicconformer-te --threads 2

CSV columns: file, language (hi|te|en), expected_text, spoken_text (blank = read correctly),
speaker, notes. Paths in 'file' are relative to the CSV's folder.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import av
import numpy as np

HERE = Path(__file__).resolve().parent
MODELS_DIR = HERE / "models"
SAMPLE_RATE = 16000
# Same punctuation set as the Karya server tokenizer (assessment_v2.tokenize).
_PUNCT = re.compile(r"[\s\.,!?;:\"'।॥()\-–—]+")


# ---------------------------------------------------------------- audio & text

def load_audio(path: Path) -> np.ndarray:
    """Decode any phone recording (m4a/aac/3gp/ogg/mp3/wav) to 16 kHz mono float32."""
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks = []
    with av.open(str(path)) as container:
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):  # flush
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise ValueError("no audio decoded")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def words(text: str) -> list[str]:
    return [w for w in _PUNCT.split(unicodedata.normalize("NFC", text).lower()) if w]


def _edit(a: list | str, b: list | str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[-1]


def cer(hyp: str, ref: str) -> float:
    """Character error rate ignoring spaces/punctuation (fair across scripts)."""
    h, r = "".join(words(hyp)), "".join(words(ref))
    return _edit(h, r) / max(1, len(r))


def wer(hyp: str, ref: str) -> float:
    return _edit(words(hyp), words(ref)) / max(1, len(words(ref)))


def mistake_verdict(hyp: str, expected: str, spoken: str) -> str:
    """For a misread sample: did the model keep the child's mistake or autocorrect it?"""
    to_spoken, to_expected = cer(hyp, spoken), cer(hyp, expected)
    if min(to_spoken, to_expected) > 0.5:
        return "unclear"  # transcript too far from both to tell
    if to_spoken < to_expected:
        return "kept"
    if to_expected < to_spoken:
        return "autocorrected"
    return "unclear"


# ---------------------------------------------------------------- engines

class SherpaEngine:
    def __init__(self, recognizer):
        self.recognizer = recognizer

    def transcribe(self, audio: np.ndarray) -> str:
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self.recognizer.decode_stream(stream)
        return stream.result.text.strip()


def _find(path: Path, *patterns: str) -> str:
    """First file in a model folder matching any pattern (exports name files differently)."""
    for pat in patterns:
        hits = sorted(path.glob(pat))
        if hits:
            return str(hits[0])
    raise FileNotFoundError(f"{path}: none of {patterns}")


def load_engine(model: dict, threads: int):
    import sherpa_onnx

    path = MODELS_DIR / model["id"]
    if model["engine"] != "sherpa-nemo-ctc":
        raise ValueError(f"unsupported engine {model['engine']}")
    return SherpaEngine(sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
        model=_find(path, "model.int8.onnx", "model.onnx"), tokens=_find(path, "tokens.txt"), num_threads=threads,
    ))


# ---------------------------------------------------------------- run

@dataclass
class Row:
    model: str
    file: str
    language: str
    expected: str
    spoken: str
    transcript: str
    cer_vs_spoken: float
    wer_vs_spoken: float
    mistake: str  # "" for correct readings; kept / autocorrected / unclear for misreads
    audio_sec: float
    rtf: float
    error: str = ""


def run(samples_csv: Path, model_ids: list[str] | None, threads: int) -> list[Row]:
    registry = json.loads((HERE / "models.json").read_text(encoding="utf-8"))["models"]
    downloaded = [m for m in registry if (MODELS_DIR / m["id"] / ".complete").exists()]
    if model_ids:
        downloaded = [m for m in downloaded if m["id"] in model_ids]
    if not downloaded:
        sys.exit("No downloaded models. Run: python download_models.py --lang hi te")

    with open(samples_csv, encoding="utf-8-sig", newline="") as fh:
        samples = [s for s in csv.DictReader(fh) if s.get("file")]
    base = samples_csv.parent
    audio_cache: dict[str, np.ndarray | Exception] = {}
    rows: list[Row] = []

    for model in downloaded:
        todo = [s for s in samples if s["language"].strip() == model["language"]]
        if not todo:
            continue
        print(f"\n▶ {model['id']} ({len(todo)} samples)")
        t0 = time.perf_counter()
        engine = load_engine(model, threads)
        print(f"  loaded in {time.perf_counter() - t0:.1f}s")
        for s in todo:
            spoken = (s.get("spoken_text") or "").strip() or s["expected_text"]
            misread = words(spoken) != words(s["expected_text"])
            if s["file"] not in audio_cache:
                try:
                    audio_cache[s["file"]] = load_audio(base / s["file"])
                except Exception as exc:  # noqa: BLE001 - report bad files, keep going
                    audio_cache[s["file"]] = exc
            audio = audio_cache[s["file"]]
            if isinstance(audio, Exception):
                rows.append(Row(model["id"], s["file"], model["language"], s["expected_text"], spoken, "", 1, 1, "", 0, 0, f"audio: {audio}"))
                print(f"  ✗ {s['file']}: cannot read audio ({audio})")
                continue
            t = time.perf_counter()
            text = engine.transcribe(audio)
            elapsed = time.perf_counter() - t
            dur = len(audio) / SAMPLE_RATE
            row = Row(
                model["id"], s["file"], model["language"], s["expected_text"], spoken, text,
                round(cer(text, spoken), 3), round(wer(text, spoken), 3),
                mistake_verdict(text, s["expected_text"], spoken) if misread else "",
                round(dur, 2), round(elapsed / max(dur, 1e-6), 3),
            )
            rows.append(row)
            flag = f"  [{row.mistake}]" if row.mistake else ""
            print(f"  {s['file']}: “{text}”  CER {row.cer_vs_spoken:.0%}{flag}")
    return rows


def summarise(rows: list[Row]) -> list[dict]:
    registry = {m["id"]: m for m in json.loads((HERE / "models.json").read_text(encoding="utf-8"))["models"]}
    out = []
    for mid in dict.fromkeys(r.model for r in rows):
        rs = [r for r in rows if r.model == mid and not r.error]
        correct = [r for r in rs if not r.mistake]
        misread = [r for r in rs if r.mistake]
        out.append({
            "model": mid,
            "language": registry[mid]["language"],
            "size_mb": registry[mid]["size_mb"],
            "samples": len(rs),
            "cer_correct_readings": round(sum(r.cer_vs_spoken for r in correct) / len(correct), 3) if correct else None,
            "cer_all": round(sum(r.cer_vs_spoken for r in rs) / len(rs), 3) if rs else None,
            "misreads": len(misread),
            "kept": sum(r.mistake == "kept" for r in misread),
            "autocorrected": sum(r.mistake == "autocorrected" for r in misread),
            "unclear": sum(r.mistake == "unclear" for r in misread),
            "avg_rtf": round(sum(r.rtf for r in rs) / len(rs), 3) if rs else None,
            "licence": registry[mid]["licence"],
        })
    return out


def write_reports(rows: list[Row], summary: list[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "results.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(Row.__dataclass_fields__.keys())
        for r in rows:
            w.writerow(r.__dict__.values())
    pct = lambda v: "—" if v is None else f"{v:.0%}"  # noqa: E731
    srows = "".join(
        f"<tr><td>{s['model']}</td><td>{s['language']}</td><td>{s['size_mb']} MB</td><td>{s['samples']}</td>"
        f"<td>{pct(s['cer_correct_readings'])}</td><td>{s['kept']} / {s['misreads']}</td><td>{s['autocorrected']}</td>"
        f"<td>{s['unclear']}</td><td>{s['avg_rtf']}</td><td>{s['licence']}</td></tr>" for s in summary)
    drows = "".join(
        f"<tr><td>{html.escape(r.model)}</td><td>{html.escape(r.file)}</td><td>{html.escape(r.expected)}</td>"
        f"<td>{html.escape(r.spoken)}</td><td>{html.escape(r.transcript) or html.escape(r.error)}</td>"
        f"<td>{pct(r.cer_vs_spoken)}</td><td>{r.mistake or '—'}</td><td>{r.rtf}</td></tr>" for r in rows)
    (out_dir / "report.html").write_text(f"""<!doctype html><meta charset="utf-8"><title>Karya speech model validation</title>
<style>body{{font:15px system-ui,"Noto Sans Devanagari","Noto Sans Telugu",sans-serif;margin:24px}}
table{{border-collapse:collapse;margin:12px 0}}td,th{{border:1px solid #ccc;padding:6px 8px;text-align:left}}th{{background:#f3f3f3}}</style>
<h1>Karya on-device speech model validation</h1>
<p><b>CER</b> = character error rate vs what was actually said (lower is better).
<b>Kept</b> = model wrote the child's mistake (good: the error stays visible).
<b>Autocorrected</b> = model wrote the expected word instead (bad: hides the error).
<b>RTF</b> = processing time ÷ audio length on this machine (below 1 = faster than real time).</p>
<h2>Summary</h2><table><tr><th>Model</th><th>Lang</th><th>Size</th><th>Samples</th><th>CER (correct readings)</th>
<th>Mistakes kept</th><th>Autocorrected</th><th>Unclear</th><th>RTF</th><th>Licence</th></tr>{srows}</table>
<h2>Every transcript</h2><table><tr><th>Model</th><th>File</th><th>Expected</th><th>Actually said</th><th>Transcript</th>
<th>CER</th><th>Mistake</th><th>RTF</th></tr>{drows}</table>""", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--samples", type=Path, required=True, help="CSV listing recordings (see samples_template.csv)")
    ap.add_argument("--models", nargs="*", help="limit to these model ids (default: all downloaded)")
    ap.add_argument("--threads", type=int, default=2, help="CPU threads; 2 approximates a budget phone")
    ap.add_argument("--out", type=Path, default=HERE / "results")
    args = ap.parse_args()
    rows = run(args.samples, args.models, args.threads)
    summary = summarise(rows)
    write_reports(rows, summary, args.out)
    print("\nSummary")
    for s in summary:
        print(f"  {s['model']:<20} CER(correct) {str(s['cer_correct_readings']):<6} "
              f"mistakes kept {s['kept']}/{s['misreads']} autocorrected {s['autocorrected']}  RTF {s['avg_rtf']}")
    print(f"\nReport: {args.out / 'report.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
