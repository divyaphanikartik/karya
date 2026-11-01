# Karya: reading-level check for rural classrooms

An offline-first Android app that helps a primary teacher find where each child stands in reading (Telugu, Hindi, English) and what to practise next.

- **Built for government and low-income schools, on ASER's tools:** Hindi/Telugu follow ASER's reading test (start at the paragraph for every child; Letter → Word → Paragraph → Story; paragraph and story need 3 or fewer mistakes and fluent reading), and the expected level stays at grade standard so the gap stays visible. English, a second language here, uses ASER's English test (every child starts at capital letters and climbs: Capital letters → Small letters → Words → Sentences), followed by ASER's meaning check: the child explains the words or sentences they read in their own language.
- **Less work for the teacher after the check:** a practice loop at the child's next step (fresh items each round until the child passes), and a review calendar that schedules each child's next check (two weeks by default, editable) and lists who is due.
- **In class, no internet needed:** add a student → the child reads aloud → the teacher taps misread words (and can time paragraph/story reading) → the level adapts → instant result with the next step to practise ("reads at Word, expected Sentence → needs help; next step: Sentence") → the home screen groups the class by level, so each group can be taught at its level.
- **Offline speech (optional):** if the language's speech model is downloaded, the phone transcribes the reading **on the device**, deletes the audio, and suggests misread words. The teacher decides.
- **When the phone finds signal:** results sync to the teacher's school (no audio), Claude writes a note per child comparing the teacher's marks with the speech model, the school's shared student list downloads, and fresh Claude-written word packs arrive.
- **Roles:** teachers run checks; an admin (e.g. the head teacher) sees the school dashboard and manages teacher accounts.

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
    auth.py              /api/auth/*                 sign-in, roles, demo test accounts
    admin.py             /api/admin/*                school dashboard, child histories, teachers
    db.py                server database schema
    sync.py              POST /api/sync, GET /api/students   records + shared school roster
    status.py            GET  /api/status            browser-friendly status table (sign-in prompt)
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

## Test credentials

Created automatically when the server starts with `KARYA_DEMO_ACCOUNTS=true` (default in this prototype, and set in
`render.yaml`). The sign-in screen lists them with a one-tap **Use** button.

| Role | Username | Password | Name | What to try |
|---|---|---|---|---|
| Admin | `admin` | `Admin@123` | Head Teacher (Demo) | School dashboard, a child's history, add/disable a teacher |
| Teacher | `teacher1` | `Teacher@123` | Lakshmi Devi (Demo) | Add a child, run a check, see the result and AI note |
| Teacher | `teacher2` | `Teacher@123` | Ravi Kumar (Demo) | See teacher1's child in the shared list and assess them too |

**See what another user sees:** open **`/api/status`** (e.g. http://localhost:8000/api/status) in a browser and sign
in when it asks. It lists every child in that user's school with their latest level, status, who checked them and
when. Use a private window to switch users; add `?format=json` for JSON. It only shows what has synced.

All three belong to **Demo Government Primary School** (`DEMO-001`). These are test-only credentials: set
`KARYA_DEMO_ACCOUNTS=false` for any deployment with real children's data, and create real teachers from the admin screen.

## Hackathon deliverables: a deployed URL and an APK

**1. Deployed URL (web app + API on one address)**

1. Put the project on GitHub. First delete `mobile/.git` (created by the Expo scaffold); otherwise git treats
   `mobile/` as a separate repository and its files are not pushed. Then `git init` at the root, commit, push.
2. On [Render](https://render.com): **New → Blueprint →** pick the repo. It reads `render.yaml` and builds the
   root `Dockerfile`. Set `ANTHROPIC_API_KEY` when asked (without it the app still works with rule-based notes).
3. Open `https://<your-service>.onrender.com`: the app loads in the browser; `/api/health` should say `"web_app": true`.
   The free plan sleeps after ~15 minutes idle, so open it a minute before judging.

Locally with Docker: `cp backend/.env.example backend/.env`, set `ANTHROPIC_API_KEY` in it, then
`docker compose up --build` and open `http://localhost:8000`. No keys go on the command line.
On any other host, set the same variables in that host's secret settings.

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
- **Speech engine:** on the phone it runs through `expo-sherpa-onnx` (`mobile/src/lib/speechEngine.ts`), which needs an EAS build (preview APK or development build) and the model downloaded in Settings; it then works with no internet. On the web (and in a build without the engine) there is no on-device engine, so recordings go to the server (`/api/transcribe`) when online and wait on the phone otherwise. The on-device engine has not yet been run on a physical phone.
- **Speech models** were compared on public adult recordings only; they must be validated on children's voices recorded on Android phones (`tools/speech_models/README.md`).
- **Privacy:** student names sync to the school's server (visible only to that school's signed-in users); audio never leaves the phone; use synthetic data or obtain consent before any real child testing.
- **Web version:** one Karya tab per browser at a time (the browser's local database allows a single open page).
