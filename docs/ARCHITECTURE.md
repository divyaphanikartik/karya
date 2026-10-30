# Karya architecture: offline-first reading-level check

## What the teacher does

1. **Add student**: name, roll number, grade, reading language (Telugu / Hindi / English), optional school code, and a voice-recording consent tick.
2. **Reading check**: the app shows items at a starting level (Sentence for Grades 1–2, Paragraph for Grade 3+). The child reads aloud and the teacher taps any word that was misread. If the phone has this language's offline speech model, the teacher can also record: the phone transcribes it **on the device**, deletes the audio, and outlines the words the speech model thinks were misread. The teacher confirms or ignores each one.
3. **Adaptive placement**: 80% or more correct moves up a level; less moves down. The check stops as soon as the level is found (usually 2–3 steps, at most 6). The ladder follows ASER: Beginner → Letter → Word → Sentence → Paragraph.
4. **Result**: shown immediately, with no internet needed: "Reads at Word, expected Sentence for Grade 2, needs extra help".
5. **Later, when the phone has signal**: the teacher's marks and the on-device transcript (text only, never audio) sync to the server, which asks Claude for a short note comparing the two views. The note appears on the result screen.

```
 PHONE (works offline)                                  SERVER (FastAPI)
 ┌───────────────────────────────────┐                  ┌───────────────────────────────────────┐
 │ SQLite: students, sessions,       │ GET content-pack │ Claude writes word packs ONCE per     │
 │ attempts, word packs              │ ◄─────────────── │ (language, grade) → validated → cached│
 │                                   │                  │                                       │
 │ Offline speech (sherpa-onnx):     │ GET speech-models│ Serves the 3 speech model files       │
 │  te: IndicConformer  138 MB       │ ◄─────────────── │ (downloaded once, on Wi-Fi)           │
 │  hi: IndicConformer  197 MB       │                  │                                       │
 │  en: FastConformer   132 MB       │                  │                                       │
 │ 16 kHz WAV → text → WAV deleted   │                  │                                       │
 │                                   │ POST assess-     │ Aligns transcript with expected text, │
 │ Placement rules (placement.ts)    │  reading (text)  │ Claude compares teacher vs speech     │
 │ Teacher marks + speech suggestions│ ───────────────► │ model → note for the teacher          │
 │                                   │ POST sync        │ Upsert records (no names, no audio)   │
 │ Sync queue (sync.ts)              │ ───────────────► │                                       │
 └───────────────────────────────────┘                  └───────────────────────────────────────┘
```

## Tech stack and why

| Layer | Choice | Why for rural deployment |
|---|---|---|
| Mobile app | **React Native + Expo SDK 58 (TypeScript), Expo Router** | One codebase, Android-first. **EAS Update** pushes JS fixes over the air, so teachers don't have to re-download the APK. The JS bundle is about 2.8 MB. |
| Local storage | **expo-sqlite** (WAL mode) | Every action is saved locally first. Nothing is lost if signal drops mid-assessment. |
| Audio | **expo-audio** stream → 16 kHz mono WAV | The input format the speech models need. Deleted immediately after on-device transcription; never uploaded. |
| Connectivity | **@react-native-community/netinfo**, store-and-forward | Syncs automatically when the network returns. Every step is safe to retry. |
| Backend | **FastAPI** (`backend/app/`) | Small, typed API: word packs, Claude notes, speech-model downloads, sync. Also serves the web build of the app, so one Docker image gives one URL. |
| Web version | **Expo web export** of the same app | For judges and supervisors on laptops. Full teacher flow; offline speech is Android-only. |
| Content generation | **Claude** (`CLAUDE_MODEL`, default `claude-sonnet-5-5`) | Writes native-script Hindi, Telugu and English items. Each pack is generated once, checked for script, item count and length, then cached, so cost doesn't grow with the number of students. |
| Speech recognition | **On the phone, offline**: AI4Bharat IndicConformer (Telugu 138 MB, Hindi 197 MB) and NVIDIA FastConformer-CTC (English 132 MB), run by **sherpa-onnx** | No API key, no per-use cost, no audio leaves the phone. Chosen with `tools/speech_models/` (see its README). Teachers download only the languages they teach: ~470 MB for all three. |
| Teacher note | **Claude** on text only (expected text + on-device transcript + teacher marks) | Claude compares the two independent views (teacher and speech model); neither is treated as the reference. If Claude fails or isn't configured, simple fixed rules write the note instead. |
| Server DB | SQLite file (prototype) → **Postgres** (Supabase / Neon) for production | **Render's free plan has a temporary disk**: the SQLite file and pack cache are lost on every redeploy. Use Postgres plus a persistent disk before a pilot. |

## Cost and storage levers built in

- **Content:** one Claude call per (language, grade), cached. It isn't called per student.
- **Audio:** never leaves the phone; deleted right after on-device transcription.
- **Speech models:** downloaded once from the Karya server (not per use).
- **Sync payload:** a few hundred bytes of JSON per attempt.
- **Claude per recorded attempt:** about 1–2k input tokens and about 200 output tokens. Check current pricing on Anthropic's pricing page.

## Privacy

- Student names stay on the phone. `/api/sync` has no name field.
- The consent tick is required before an assessment starts.
- AI output is labelled as a second opinion. The teacher's marks decide the level. No disability labels and no pronunciation scores.

## What is validated and what is not

- Automated: 31 backend tests and 13 mobile logic tests (placement, alignment). The Docker image was built and the web app's full teacher flow was driven end to end in headless Chrome. The mobile app passes the type-check and lint, and its Android bundle builds.
- Tested against the live Claude key: content-pack generation (hi/te/en) and teacher-note generation.
- **Speech models:** compared on public adult recordings only (12–16 words per language). **Not tested:** children's voices, the app on a physical phone, memory use on low-end phones.
- **Not wired yet:** the native speech engine in the app (`mobile/src/lib/speechEngine.ts`). It needs a sherpa-onnx React Native package approved and a development build. Until then the app runs on teacher marks alone.
- **Also not validated:** The placement thresholds (80%, expected level per grade) are draft values. All Hindi and Telugu content and UI text needs review by fluent early-literacy reviewers.

## Next steps

1. Install on 2–3 low-end Android phones (2–3 GB RAM) and run with synthetic or consented readers.
2. Approve a sherpa-onnx package, wire `speechEngine.ts`, make an EAS development build, and record children on Android phones to validate the three speech models (`tools/speech_models/`).
3. Move server storage to Postgres, add per-device auth tokens, and deploy over HTTPS (release APKs block plain `http://`).
4. Teacher dashboard: class-level summary of who needs help.
5. Later: build our own Hindi-only IndicConformer export (~140 MB) from AI4Bharat's official checkpoint, and a free-speech task if grammar assessment is needed.
