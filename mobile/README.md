# Karya: mobile app

Offline-first Android app for teachers. See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the design.

## Run on your phone

1. Start the backend (see the root README for first-time setup):
   ```bash
   cd backend && source .venv/bin/activate
   uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```
2. Start the app:
   ```bash
   cd mobile
   npm install
   npm run build:apk          # cloud build of a stand-alone APK (the "test" profile), about 15 minutes
   ```
3. Install the `.apk` on the phone. It is the real app: no Expo Go, no dev server, and it works with no laptop. In
   Settings (or on the sign-in screen) set the server address, for example `http://<laptop-IP>:8000`; the "test"
   profile allows plain http for that. For a deployed server use the `preview` profile with an https address.

## Offline speech models

1. On the server machine, fetch and publish the three models once (from the repo root):
   ```bash
   cd tools/speech_models
   python download_models.py --lang te hi en --publish ../../backend/data/speech_models
   ```
2. In the app: **Settings → Offline speech models → Download** (about 140–200 MB each, best on Wi-Fi).
3. The native engine is not wired yet: `src/lib/speechEngine.ts` is the single place to connect a sherpa-onnx package (`expo-sherpa-onnx` or `react-native-sherpa-onnx`). Until then the app tells the teacher speech isn't in this build and works on teacher marks alone.

## Build an APK

See "Hackathon deliverables" in the root README. In short:

```bash
npx eas-cli@latest login && npx eas-cli@latest init
# set EXPO_PUBLIC_API_URL in eas.json ("preview") to the deployed HTTPS URL
npx eas-cli@latest build -p android --profile preview
```

Release builds block plain `http://`, so point the APK at an HTTPS deployment.

## Web build

The same code runs in a browser (`npx expo start --web`, or the root `Dockerfile` for deployment). On web the app
talks to the server that served it, stores data in the browser (SQLite via WebAssembly, which needs the
cross-origin isolation headers the backend sends), and hides offline speech, which is Android-only.

## Checks

```bash
npm run typecheck     # TypeScript
npx expo lint         # ESLint
npm test              # placement + alignment logic (node --test)
```

## Code map

| File | Purpose |
|---|---|
| `src/app/index.tsx` | Student list, sync status |
| `src/app/student/new.tsx` | Add student (name, code, grade, language, consent) |
| `src/app/assess/[studentId].tsx` | Adaptive reading check: tap misread words, optional on-device speech suggestions |
| `src/app/result/[sessionId].tsx` | Placement result plus AI notes once synced |
| `src/app/settings.tsx` | Offline speech model downloads, server address, teacher UI language |
| `src/lib/placement.ts` | ASER-style level ladder and pass rules (pure, unit tested) |
| `src/lib/align.ts` | Matches the speech model's transcript to the expected words (unit tested) |
| `src/lib/speech.ts` | Speech model download, 16 kHz WAV recording, transcribe-then-delete |
| `src/lib/speechEngine.ts` | The one adapter for the native speech engine (not wired yet) |
| `src/lib/db.ts` | SQLite schema and queries |
| `src/lib/sync.ts` | Upload queue: content packs, Claude notes (text only), record sync |
| `src/lib/AppProvider.tsx` | Connectivity, auto-sync, UI language |
| `src/lib/i18n.ts` | English / Hindi / Telugu UI strings (Hindi/Telugu need review) |
| `src/lib/seedPacks.json` | Built-in word packs for first-day offline use (kept equal to the server by a test) |
