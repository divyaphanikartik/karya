# Karya: reading-level check for rural classrooms

An offline-first Android app that helps a primary teacher find where each child stands in reading (Telugu, Hindi, English) and what to practise next.

- **In class, no internet needed:** add a student → the app shows letters, words, sentences or a paragraph → the child reads aloud → the teacher taps misread words → the level adapts (ASER ladder: Beginner → Letter → Word → Sentence → Paragraph) → instant result ("reads at Word level, expected Sentence → needs help").
- **Offline speech (optional):** if the language's speech model is downloaded, the phone transcribes the reading **on the device**, deletes the audio, and suggests misread words. The teacher decides.
- **When the phone finds signal:** results sync (no names, no audio), Claude writes a note per child comparing the teacher's marks with the speech model, and fresh Claude-written word packs download.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design, tech stack and validation status.

## Repository layout

```
backend/                 FastAPI server
  app/
    main.py              entry point (/api/health) and router wiring
    config.py            settings from environment / backend/.env
    claude.py            Claude API client (structured JSON) + rate limit
    content.py           GET  /api/content-pack      word packs (seed + Claude, cached)
    assess.py            POST /api/assess-reading    Claude teacher note (text only)
    sync.py              POST /api/sync              pseudonymous records (no names)
    speech_models.py     GET  /api/speech-models     offline speech model downloads
    web.py               serves the web build of the app for every non-/api path
    languages.py         shared language / level types
  tests/                 pytest suite (never calls paid APIs)
  requirements.txt, .env.example
mobile/                  Expo (React Native) app: Android APK + web build; see mobile/README.md
  eas.json               EAS build profiles (preview = installable .apk)
tools/speech_models/     download, publish and validate the 3 offline speech models
docs/ARCHITECTURE.md
Dockerfile               one image: web build of the app + API on the same URL
render.yaml              Render deployment of that image
```

## Hackathon deliverables: a deployed URL and an APK

**1. Deployed URL (web app + API on one address)**

1. Put the project on GitHub. First delete `mobile/.git` (created by the Expo scaffold); otherwise git treats
   `mobile/` as a separate repository and its files are not pushed. Then `git init` at the root, commit, push.
2. On [Render](https://render.com): **New → Blueprint →** pick the repo. It reads `render.yaml` and builds the
   root `Dockerfile`. Set `ANTHROPIC_API_KEY` when asked (without it the app still works with rule-based notes).
3. Open `https://<your-service>.onrender.com`: the app loads in the browser; `/api/health` should say `"web_app": true`.
   The free plan sleeps after ~15 minutes idle, so open it a minute before judging.

Any Docker host works the same way: `docker build -t karya . && docker run -p 8000:8000 -e ANTHROPIC_API_KEY=... karya`.

The browser version is the full teacher flow (students, adaptive check, results, sync, Claude notes). Offline speech
is Android-only.

**2. APK (Android)**

```bash
cd mobile
npx eas-cli@latest login            # free Expo account
npx eas-cli@latest init             # links the project (adds its id to app.json)
# edit eas.json: set EXPO_PUBLIC_API_URL in the "preview" profile to the deployed URL from step 1
npx eas-cli@latest build -p android --profile preview
```

EAS builds in the cloud (about 10–20 minutes) and prints a download link for the `.apk`. Judges install it on
any Android phone (allow "install unknown apps"). The app reaches the deployed server for word packs, sync and
Claude notes, and works offline in between.

## Run the backend

Python 3.12 recommended.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env                 # then set ANTHROPIC_API_KEY (optional: without it, demo rules are used)
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Check `http://localhost:8000/api/health`. API docs are at `/docs`. To also serve the web app locally,
run `npx expo export --platform web --output-dir ../backend/web` in `mobile/` and reload `http://localhost:8000`.

Publish the offline speech models so phones can download them (once, ~470 MB):

```bash
cd tools/speech_models
pip install -r requirements.txt
python download_models.py --lang te hi en --publish ../../backend/data/speech_models
```

## Run the mobile app

```bash
cd mobile
npm install
npx expo start
```

Details, including speech setup: [`mobile/README.md`](mobile/README.md).

## Tests

```bash
cd backend && pytest -q        # API, content validation, alignment, sync, speech-model serving
cd mobile && npm test          # placement and alignment logic
cd mobile && npx tsc --noEmit && npx expo lint
```

## Status and limits

- **Prototype.** Word lists, thresholds (80% to pass a level; expected level per grade) and Hindi/Telugu UI text are drafts that need review by early-literacy educators and fluent speakers.
- **Speech engine not wired yet:** `mobile/src/lib/speechEngine.ts` needs a sherpa-onnx React Native package and an EAS development build. Until then the app works on teacher marks alone.
- **Speech models** were compared on public adult recordings only; they must be validated on children's voices recorded on Android phones (`tools/speech_models/README.md`).
- **Privacy:** student names stay on the phone; audio never leaves it; use synthetic data or obtain consent before any real child testing.
