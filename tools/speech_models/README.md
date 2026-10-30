# On-device speech model validation (Windows / Linux / macOS)

Checks the three open-source speech models Karya runs **on the phone, offline**, using recordings made on **Android phones**, the real classroom device:

| Language | Model | Size | Licence |
|---|---|---|---|
| Telugu | AI4Bharat IndicConformer (`indicconformer-te`) | 138 MB | MIT |
| Hindi | AI4Bharat IndicConformer (`indicconformer-hi`) | 197 MB | MIT |
| English | NVIDIA FastConformer-CTC (`nemo-fastconformer-en`) | 132 MB | CC-BY-4.0 (confirm before shipping) |

All three run on the same engine (sherpa-onnx). For each it answers:

| Question | Measure |
|---|---|
| How accurate is it? | **CER**: character error rate vs what was actually said (lower is better) |
| Does it hide children's mistakes? | When the child misread, did the model **keep** the mistake or **autocorrect** it to the expected word? |
| Is it fast enough for a phone? | **RTF**: processing time ÷ audio length (below 1 = faster than real time) |
| Will it fit? | Download size in MB |

> These models are not Anthropic. Check the hackathon rules before shipping one in the app.

## 1. Record samples on Android phones

Use any voice-recorder app on a typical teacher phone (or the Karya app's record button). Record in a normal classroom, not a studio.

For each language, aim for **15–30 short recordings** (one word or one sentence each):
- About two-thirds **read correctly**.
- About one-third with a **deliberate, realistic mistake**, ideally **non-words** like a child would produce:
  - Hindi: किताब read as **कीताब** (long vowel), कमल read as **कम** (dropped syllable)
  - Telugu: కిటికీ read as **కిటికి**, అమ్మ read as **అమా**
  - English: ship read as **sip**, the cat sat → the sat

Mix adult and (with consent) child voices if possible. Children's voices are what matter in the end.

Copy the files to a folder, e.g. `samples/phone/`. Any format works (`.m4a`, `.aac`, `.3gp`, `.ogg`, `.mp3`, `.wav`).

## 2. Describe them in a CSV

Copy `samples_template.csv` to `samples/phone/samples.csv` and fill one row per recording:

| Column | Meaning |
|---|---|
| `file` | file name, relative to the CSV |
| `language` | `hi`, `te` or `en` |
| `expected_text` | what was **shown** to the reader |
| `spoken_text` | what was **actually said**. Leave blank if read correctly |
| `speaker` | `child` / `adult` (optional) |
| `notes` | anything useful |

Save as **UTF-8** (Excel: *Save As → CSV UTF-8*) so Hindi and Telugu text survives.

## 3. Install (once)

Install **Python 3.12** (on Windows, tick *"Add python.exe to PATH"*). Newer Python versions may lack some packages.

**Windows (PowerShell):**
```powershell
cd tools\speech_models
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**Linux / macOS:**
```bash
cd tools/speech_models
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

No FFmpeg install is needed: the `av` package bundles its own decoder.

## 4. Download models

```bash
python download_models.py                  # list the models
python download_models.py --lang te hi en  # all three (~470 MB)
python download_models.py --lang te hi en --publish ../../backend/data/speech_models  # also hand them to the Karya server
```

## 5. Run

```bash
python validate.py --samples samples/phone/samples.csv
```

Open `results/report.html` for the summary and every transcript; `results/results.csv` has the raw numbers.
`--threads 2` (the default) roughly approximates a budget phone's CPU budget.

## Reading the results

- Healthy result: **low CER on correct readings**, **most mistakes kept** (not autocorrected), and **RTF well below 1**.
- A model that scores well on correct readings but **autocorrects** mistakes would hide children's errors.
- Laptop speed is only a rough guide; confirm speed and memory inside the Android app on a real low-end phone.

## Results so far (public adult recordings, not children)

Single words from Wikimedia Commons / Lingua Libre volunteers (CC BY-SA 4.0), plus simulated misreads made by
labelling a real recording of a different word (e.g. shown जाना, said जीना; shown ship, said sheep).
Run 2026-10-30 on a laptop, 2 threads. The recordings are not kept in this repo.

| Model | Words | Correct readings fully right | CER (correct readings) | Simulated misread kept | RTF |
|---|---|---|---|---|---|
| `indicconformer-te` | 12 | 9 / 12 | 12% | 1 / 1 | 0.05 |
| `indicconformer-hi` | 12 | 11 / 12 | 3% | 1 / 1 | 0.04 |
| `nemo-fastconformer-en` | 16 | 12 / 13 | 3% | 2 / 3 (third unclear) | 0.02 |

These models were chosen over Vosk, Whisper (tiny/small Indic fine-tunes, tiny.en), Moonshine tiny and NeMo
Conformer-small, which were less accurate or rewrote misreads into real words (e.g. sheep → "shape").
**The decisive test is still children reading on Android phones.**
