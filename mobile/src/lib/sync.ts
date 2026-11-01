// Store-and-forward sync. Safe to call repeatedly: every step is idempotent, and any
// network failure leaves the local rows untouched for the next attempt.
import type { SQLiteDatabase } from 'expo-sqlite';
import { AuthError, apiFetch, apiUrl } from './api';
import {
  deviceId, getSetting, mergeRoster, remapStudentId, savePack, savePracticePack, saveSessionSummary,
  type Attempt, type ContentPack, type PracticePlan, type PracticeRound, type RosterStudent,
} from './db';
import { tokens, type Language } from './placement';
import { discardRecording, recordingExists, transcribeOnDevice, uploadRecording } from './speech';

export { apiUrl } from './api';

const PACK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_AI_TRIES = 5;
const BATCH = 10;

export type SyncResult = { transcribed: number; analysed: number; summarised: number; pushed: number; packs: number; rosterAdded: number };

// Check items and practice items are separate packs, cached in their own tables.
const PACK_KINDS = [
  { kind: 'check', table: 'content_packs', save: savePack },
  { kind: 'practice', table: 'practice_packs', save: savePracticePack },
] as const;

async function refreshPacks(db: SQLiteDatabase): Promise<number> {
  let updated = 0;
  for (const { kind, table, save } of PACK_KINDS) {
    const wanted = await db.getAllAsync<{ language: string; grade: number; fetched_at: string | null }>(`
      SELECT DISTINCT s.language, s.grade, p.fetched_at FROM students s
      LEFT JOIN ${table} p ON p.language = s.language AND p.grade = s.grade`);
    for (const w of wanted) {
      if (w.fetched_at && Date.now() - Date.parse(w.fetched_at) < PACK_MAX_AGE_MS) continue;
      const res = await apiFetch(db, `/api/content-pack?language=${w.language}&grade=${w.grade}&kind=${kind}`, {}, 90000);
      if (!res.ok) continue;
      const pack = (await res.json()) as ContentPack;
      // Seed packs are already bundled in the app; only store server packs that add content.
      if (pack.source === 'claude') {
        await save(db, pack, w.grade);
        updated++;
      }
    }
  }
  return updated;
}

type PendingAttempt = Attempt & { language: string; grade: number };

async function analyseAttempt(db: SQLiteDatabase, a: PendingAttempt, noteLanguage: string): Promise<'done' | 'retry' | 'failed'> {
  const items: string[] = JSON.parse(a.items_json);
  const marks: boolean[] = JSON.parse(a.marks_json);
  // Text only: the teacher's marks and the on-device transcript. Audio never leaves the phone.
  const body = {
    attempt_id: a.id, language: a.language, level: a.level, grade: a.grade,
    expected_items: items, teacher_marks: marks.slice(0, tokens(items).length), duration_sec: a.duration_sec,
    asr_transcript: a.asr_transcript, asr_model: a.asr_model,
    note_language: noteLanguage, // the note is written in the teacher's app language
  };
  // A network failure throws here, before the try is counted: not being able to reach the server is not
  // the attempt's fault, and counting it used to leave attempts stuck for good after a few failed syncs.
  const res = await apiFetch(db, '/api/assess-reading', { method: 'POST', body: JSON.stringify(body) }, 90000);
  await db.runAsync('UPDATE attempts SET ai_tries = ai_tries + 1 WHERE id = ?', a.id);
  if (res.status === 429 || res.status >= 500) return 'retry';
  if (!res.ok) {
    await db.runAsync("UPDATE attempts SET ai_status = 'failed' WHERE id = ?", a.id);
    return 'failed';
  }
  const result = (await res.json()) as { feedback_source?: string };
  if (result.feedback_source === 'rule_fallback') {
    // The server could not reach Claude (its own connection was down). Keep the stand-in note on screen
    // but try again at the next syncs; after MAX_AI_TRIES it stays as the final note.
    if (a.ai_tries + 1 < MAX_AI_TRIES) {
      await db.runAsync('UPDATE attempts SET ai_result_json = ? WHERE id = ?', JSON.stringify(result), a.id);
      return 'retry';
    }
    result.feedback_source = 'rules_offline';
  }
  await db.runAsync(
    "UPDATE attempts SET ai_status = 'done', ai_result_json = ?, synced = 0 WHERE id = ?",
    JSON.stringify(result), a.id,
  );
  return 'done';
}

/**
 * Recordings made offline: send them to the server's speech model now, store the transcript on the
 * attempt and delete the audio. Runs before the Claude notes so Claude sees transcript and taps together.
 */
async function transcribePending(db: SQLiteDatabase): Promise<number> {
  const waiting = await db.getAllAsync<{ id: string; audio_uri: string; language: Language }>(`
    SELECT a.id, a.audio_uri, s.language FROM attempts a JOIN sessions s ON s.id = a.session_id
    WHERE a.asr_status = 'pending' AND a.audio_uri IS NOT NULL ORDER BY a.created_at LIMIT ?`, BATCH);
  let done = 0;
  for (const w of waiting) {
    if (!recordingExists(w.audio_uri)) {
      // The file is gone, so it can never be sent: carry on without speech for this attempt instead of
      // holding up its note and upload for ever.
      await db.runAsync("UPDATE attempts SET asr_status = 'failed', audio_uri = NULL WHERE id = ?", w.id);
      continue;
    }
    // A model installed since the recording was made can transcribe it on the phone, with no upload.
    const local = await transcribeOnDevice(db, w.language, w.audio_uri);
    if (local) {
      await db.runAsync(
        "UPDATE attempts SET asr_transcript = ?, asr_model = ?, asr_status = 'done', audio_uri = NULL WHERE id = ?",
        local.transcript, local.modelId, w.id);
      discardRecording(w.audio_uri);
      done++;
      continue;
    }
    let res: Response;
    try {
      res = await uploadRecording(db, w.language, w.audio_uri);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      // Not swallowed: the banner shows why the recording did not go up (and which file).
      throw new Error(`${e instanceof Error ? e.message : String(e)} [${w.audio_uri}]`);
    }
    if (res.status === 429 || (res.status >= 500 && res.status !== 503)) break; // server busy
    if (res.ok) {
      const body = (await res.json()) as { transcript: string; model: string };
      await db.runAsync(
        "UPDATE attempts SET asr_transcript = ?, asr_model = ?, asr_status = 'done', audio_uri = NULL WHERE id = ?",
        body.transcript, body.model, w.id);
      done++;
    } else {
      // No model for this language, or an unreadable recording: give up on speech for this attempt.
      await db.runAsync("UPDATE attempts SET asr_status = 'failed', audio_uri = NULL WHERE id = ?", w.id);
    }
    discardRecording(w.audio_uri);
  }
  return done;
}

async function analysePending(db: SQLiteDatabase): Promise<number> {
  // An attempt the server has refused to analyse MAX_AI_TRIES times must not hold up its upload for ever:
  // it goes up without an AI note (or with its stand-in note, if it has one).
  await db.runAsync(`UPDATE attempts SET ai_status = 'failed', synced = 0
    WHERE ai_status = 'pending' AND ai_tries >= ? AND ai_result_json IS NULL AND (asr_status IS NULL OR asr_status != 'pending')`, MAX_AI_TRIES);
  await db.runAsync(`UPDATE attempts SET ai_status = 'done', synced = 0
    WHERE ai_status = 'pending' AND ai_tries >= ? AND ai_result_json IS NOT NULL`, MAX_AI_TRIES);
  // Notes saved as a stand-in because Claude was unreachable at the time get another chance.
  await db.runAsync(`UPDATE attempts SET ai_status = 'pending', ai_tries = 0, synced = 0
    WHERE ai_status = 'done' AND ai_result_json LIKE '%"feedback_source":"rule_fallback"%'`);
  // Attempts whose recording is still waiting for the speech model are analysed after it is transcribed.
  const pending = await db.getAllAsync<PendingAttempt>(`
    SELECT a.*, s.language, s.grade FROM attempts a JOIN sessions s ON s.id = a.session_id
    WHERE a.ai_status = 'pending' AND a.ai_tries < ? AND (a.asr_status IS NULL OR a.asr_status != 'pending')
    ORDER BY a.created_at LIMIT ?`, MAX_AI_TRIES, BATCH);
  const noteLanguage = (await getSetting(db, 'ui_lang')) || 'en';
  let done = 0;
  for (const a of pending) {
    const outcome = await analyseAttempt(db, a, noteLanguage);
    if (outcome === 'done') done++;
    if (outcome === 'retry') break; // server busy or rate-limited; try again next sync
  }
  return done;
}

/**
 * Once every section of a finished check has its own note, ask Claude for the whole-check summary:
 * a line per section, an overall summary and a retest built from the child's mistakes. Text only.
 */
async function summarisePending(db: SQLiteDatabase): Promise<number> {
  const sessions = await db.getAllAsync<{ id: string; language: string; grade: number; ai_summary_json: string | null }>(`
    SELECT s.id, s.language, s.grade, s.ai_summary_json FROM sessions s
    WHERE s.finished_at IS NOT NULL AND s.id NOT LIKE 'server-%'
      AND (s.ai_summary_json IS NULL OR s.ai_summary_json LIKE '%"source":"rule_fallback"%')
      AND EXISTS (SELECT 1 FROM attempts a WHERE a.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.session_id = s.id
        AND ((a.ai_status = 'pending' AND a.ai_tries < ${MAX_AI_TRIES}) OR a.asr_status = 'pending'))
    ORDER BY s.finished_at DESC LIMIT 5`);
  const noteLanguage = (await getSetting(db, 'ui_lang')) || 'en';
  let done = 0;
  for (const s of sessions) {
    const attempts = await db.getAllAsync<Attempt>('SELECT * FROM attempts WHERE session_id = ? ORDER BY created_at', s.id);
    const body = {
      session_id: s.id, language: s.language, grade: s.grade, note_language: noteLanguage,
      sections: attempts.map((a) => {
        const items: string[] = JSON.parse(a.items_json);
        return {
          level: a.level, expected_items: items, teacher_marks: (JSON.parse(a.marks_json) as boolean[]).slice(0, tokens(items).length),
          asr_transcript: a.asr_transcript,
        };
      }),
    };
    const res = await apiFetch(db, '/api/assess-session', { method: 'POST', body: JSON.stringify(body) }, 90000);
    if (res.status === 429 || res.status >= 500) break; // busy or rate-limited: try again next sync
    if (!res.ok) {
      await saveSessionSummary(db, s.id, { failed: true }); // a request the server rejects will not improve by retrying
      continue;
    }
    const summary = (await res.json()) as { source: string; tries?: number };
    if (summary.source === 'rule_fallback') {
      // Claude was unreachable from the server: keep the stand-in, retry at the next syncs (a few times).
      const tries = (s.ai_summary_json ? (JSON.parse(s.ai_summary_json).tries ?? 0) : 0) + 1;
      summary.tries = tries;
      if (tries >= MAX_AI_TRIES) summary.source = 'rules_offline';
      await saveSessionSummary(db, s.id, summary as never);
      continue;
    }
    await saveSessionSummary(db, s.id, summary as never);
    done++;
  }
  return done;
}

const SYNCED_TABLES = ['students', 'sessions', 'attempts', 'practice', 'practice_plans', 'reviews'] as const;
type SyncedTable = (typeof SYNCED_TABLES)[number];

async function pushRecords(db: SQLiteDatabase): Promise<number> {
  const students = await db.getAllAsync<Record<string, unknown>>(
    'SELECT id, student_code, name, grade, language, updated_at, next_review FROM students WHERE synced = 0 LIMIT 500');
  const sessions = await db.getAllAsync<Record<string, unknown>>(
    `SELECT id, student_id, language, grade, placed_level, needs_help, started_at, finished_at,
       meaning_level, meaning_marks_json, meaning_can_say
     FROM sessions WHERE synced = 0 AND finished_at IS NOT NULL LIMIT 500`);
  const attempts = await db.getAllAsync<Attempt>(
    "SELECT * FROM attempts WHERE synced = 0 AND ai_status != 'pending' LIMIT 1000");
  const practice = await db.getAllAsync<PracticeRound>('SELECT * FROM practice WHERE synced = 0 LIMIT 1000');
  const plans = await db.getAllAsync<PracticePlan>('SELECT * FROM practice_plans WHERE synced = 0 LIMIT 1000');
  const reviews = await db.getAllAsync<{ id: string; student_id: string; language: string; next_review: string; updated_at: string }>(
    'SELECT id, student_id, language, next_review, updated_at FROM reviews WHERE synced = 0 LIMIT 500');
  if (!students.length && !sessions.length && !attempts.length && !practice.length && !plans.length && !reviews.length) return 0;

  const body = {
    device_id: await deviceId(db),
    students, // school and teacher come from the sign-in token on the server
    sessions: sessions.map(({ meaning_marks_json, ...s }) => {
      // Only counts go up for the meaning check, not the items.
      const marks: boolean[] | null = meaning_marks_json ? JSON.parse(meaning_marks_json as string) : null;
      return {
        ...s,
        needs_help: s.needs_help == null ? null : Boolean(s.needs_help),
        meaning_correct: marks ? marks.filter(Boolean).length : null,
        meaning_total: marks ? marks.length : null,
        meaning_can_say: s.meaning_can_say == null ? null : Boolean(s.meaning_can_say),
      };
    }),
    attempts: attempts.map((a) => ({
      id: a.id, session_id: a.session_id, level: a.level, accuracy: a.accuracy, passed: Boolean(a.passed),
      items: JSON.parse(a.items_json), marks: JSON.parse(a.marks_json), // per-word taps, so admins see missed words
      duration_sec: a.duration_sec, created_at: a.created_at, fluent: a.fluent == null ? null : Boolean(a.fluent),
      ai_result: a.ai_result_json ? JSON.parse(a.ai_result_json) : null,
    })),
    reviews, // next review date per child and language
    // Practice rounds: counts only (the items are not needed on the server).
    practice: practice.map((p) => {
      const marks: boolean[] = JSON.parse(p.marks_json);
      return {
        id: p.id, student_id: p.student_id, level: p.level, correct: marks.filter(Boolean).length, total: marks.length,
        fluent: p.fluent == null ? null : Boolean(p.fluent), passed: Boolean(p.passed), created_at: p.created_at,
      };
    }),
    // Practice plans: level, how many items, the day and whether it was done (not the items).
    practice_plans: plans.map((p) => ({
      id: p.id, student_id: p.student_id, level: p.level, item_count: (JSON.parse(p.items_json) as string[]).length,
      due_date: p.due_date, done_at: p.done_at, created_at: p.created_at,
    })),
  };
  const res = await apiFetch(db, '/api/sync', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Sync rejected (HTTP ${res.status})`);
  const { accepted, student_ids } = (await res.json()) as {
    accepted: Partial<Record<SyncedTable, string[]>>;
    student_ids?: Record<string, string>;
  };
  let count = 0;
  await db.withTransactionAsync(async () => {
    for (const table of SYNCED_TABLES) {
      for (const id of accepted[table] ?? []) await db.runAsync(`UPDATE ${table} SET synced = 1 WHERE id = ?`, id);
      count += accepted[table]?.length ?? 0;
    }
    // Another teacher already added this child (same roll number): use the school's record.
    for (const [phoneId, serverId] of Object.entries(student_ids ?? {})) await remapStudentId(db, phoneId, serverId);
  });
  return count;
}

/** Pull the school's roster so this teacher can assess children other teachers added. */
async function pullRoster(db: SQLiteDatabase): Promise<number> {
  const res = await apiFetch(db, '/api/students');
  if (!res.ok) return 0;
  const { students } = (await res.json()) as { students: RosterStudent[] };
  return mergeRoster(db, students);
}

/** Run one sync step; a failure says which step and which server address it was talking to. */
async function step<T>(db: SQLiteDatabase, name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AuthError) throw e;
    const base = await apiUrl(db);
    throw new Error(`${name} failed (${base}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runSync(db: SQLiteDatabase): Promise<SyncResult> {
  // Push first so this phone's new children get server ids before the roster is merged back.
  const packs = await step(db, 'word lists', () => refreshPacks(db));
  const transcribed = await step(db, 'recordings', () => transcribePending(db));
  const analysed = await step(db, 'AI notes', () => analysePending(db));
  const summarised = await step(db, 'summaries', () => summarisePending(db));
  const pushed = await step(db, 'upload', () => pushRecords(db));
  const rosterAdded = await step(db, 'student list', () => pullRoster(db));
  return { transcribed, analysed, summarised, pushed, packs, rosterAdded };
}

export async function pendingCounts(db: SQLiteDatabase): Promise<{ notes: number; records: number }> {
  const a = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE ai_status = 'pending'");
  const r = await db.getFirstAsync<{ n: number }>(`SELECT
    (SELECT COUNT(*) FROM students WHERE synced = 0) +
    (SELECT COUNT(*) FROM sessions WHERE synced = 0 AND finished_at IS NOT NULL) +
    (SELECT COUNT(*) FROM attempts WHERE synced = 0) +
    (SELECT COUNT(*) FROM practice WHERE synced = 0) +
    (SELECT COUNT(*) FROM practice_plans WHERE synced = 0) +
    (SELECT COUNT(*) FROM reviews WHERE synced = 0) AS n`);
  return { notes: a?.n ?? 0, records: r?.n ?? 0 };
}
