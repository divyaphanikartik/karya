// Store-and-forward sync. Safe to call repeatedly: every step is idempotent, and any
// network failure leaves the local rows untouched for the next attempt.
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { deviceId, getSetting, savePack, type Attempt, type ContentPack } from './db';
import { tokens } from './placement';

const PACK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_AI_TRIES = 5;
const BATCH = 10;

export type SyncResult = { analysed: number; pushed: number; packs: number };

/**
 * Server address, in priority order: the teacher's Settings value; EXPO_PUBLIC_API_URL baked in at
 * build time (the APK); on web, the server that served the page; else the Android emulator's host.
 */
export async function apiUrl(db: SQLiteDatabase): Promise<string> {
  const saved = await getSetting(db, 'api_url');
  const fallback =
    process.env.EXPO_PUBLIC_API_URL ||
    (Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : '') ||
    (Constants.expoConfig?.extra?.apiUrl as string | undefined) ||
    'http://10.0.2.2:8000';
  return (saved || fallback).replace(/\/+$/, '');
}

async function request(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshPacks(db: SQLiteDatabase, base: string): Promise<number> {
  const wanted = await db.getAllAsync<{ language: string; grade: number; fetched_at: string | null }>(`
    SELECT DISTINCT s.language, s.grade, p.fetched_at FROM students s
    LEFT JOIN content_packs p ON p.language = s.language AND p.grade = s.grade`);
  let updated = 0;
  for (const w of wanted) {
    if (w.fetched_at && Date.now() - Date.parse(w.fetched_at) < PACK_MAX_AGE_MS) continue;
    const res = await request(`${base}/api/content-pack?language=${w.language}&grade=${w.grade}`, {}, 90000);
    if (!res.ok) continue;
    const pack = (await res.json()) as ContentPack;
    // Seed packs are already bundled in the app; only store server packs that add content.
    if (pack.source === 'claude') {
      await savePack(db, pack, w.grade);
      updated++;
    }
  }
  return updated;
}

type PendingAttempt = Attempt & { language: string; grade: number };

async function analyseAttempt(
  db: SQLiteDatabase, base: string, a: PendingAttempt, noteLanguage: string,
): Promise<'done' | 'retry' | 'failed'> {
  const items: string[] = JSON.parse(a.items_json);
  const marks: boolean[] = JSON.parse(a.marks_json);
  // Text only: the teacher's marks and the on-device transcript. Audio never leaves the phone.
  const body = {
    attempt_id: a.id, language: a.language, level: a.level, grade: a.grade,
    expected_items: items, teacher_marks: marks.slice(0, tokens(items).length), duration_sec: a.duration_sec,
    asr_transcript: a.asr_transcript, asr_model: a.asr_model,
    note_language: noteLanguage, // the note is written in the teacher's app language
  };
  await db.runAsync('UPDATE attempts SET ai_tries = ai_tries + 1 WHERE id = ?', a.id);
  const res = await request(`${base}/api/assess-reading`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, 90000);
  if (res.status === 429 || res.status >= 500) return 'retry';
  if (!res.ok) {
    await db.runAsync("UPDATE attempts SET ai_status = 'failed' WHERE id = ?", a.id);
    return 'failed';
  }
  await db.runAsync(
    "UPDATE attempts SET ai_status = 'done', ai_result_json = ?, synced = 0 WHERE id = ?",
    JSON.stringify(await res.json()), a.id,
  );
  return 'done';
}

async function analysePending(db: SQLiteDatabase, base: string): Promise<number> {
  const pending = await db.getAllAsync<PendingAttempt>(`
    SELECT a.*, s.language, s.grade FROM attempts a JOIN sessions s ON s.id = a.session_id
    WHERE a.ai_status = 'pending' AND a.ai_tries < ? ORDER BY a.created_at LIMIT ?`, MAX_AI_TRIES, BATCH);
  const noteLanguage = (await getSetting(db, 'ui_lang')) || 'en';
  let done = 0;
  for (const a of pending) {
    const outcome = await analyseAttempt(db, base, a, noteLanguage);
    if (outcome === 'done') done++;
    if (outcome === 'retry') break; // server busy or rate-limited; try again next sync
  }
  return done;
}

async function pushRecords(db: SQLiteDatabase, base: string): Promise<number> {
  const students = await db.getAllAsync<Record<string, unknown>>(
    'SELECT id, student_code, grade, school_code, language, updated_at FROM students WHERE synced = 0 LIMIT 500');
  const sessions = await db.getAllAsync<Record<string, unknown>>(
    'SELECT id, student_id, language, grade, placed_level, needs_help, started_at, finished_at FROM sessions WHERE synced = 0 AND finished_at IS NOT NULL LIMIT 500');
  const attempts = await db.getAllAsync<Attempt>(
    "SELECT * FROM attempts WHERE synced = 0 AND ai_status != 'pending' LIMIT 1000");
  if (!students.length && !sessions.length && !attempts.length) return 0;

  const body = {
    device_id: await deviceId(db),
    students, // name is intentionally not selected: it stays on this phone
    sessions: sessions.map((s) => ({ ...s, needs_help: s.needs_help == null ? null : Boolean(s.needs_help) })),
    attempts: attempts.map((a) => ({
      id: a.id, session_id: a.session_id, level: a.level, accuracy: a.accuracy, passed: Boolean(a.passed),
      duration_sec: a.duration_sec, created_at: a.created_at,
      ai_result: a.ai_result_json ? JSON.parse(a.ai_result_json) : null,
    })),
  };
  const res = await request(`${base}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sync rejected (HTTP ${res.status})`);
  const { accepted } = (await res.json()) as { accepted: Record<'students' | 'sessions' | 'attempts', string[]> };
  await db.withTransactionAsync(async () => {
    for (const table of ['students', 'sessions', 'attempts'] as const) {
      for (const id of accepted[table]) await db.runAsync(`UPDATE ${table} SET synced = 1 WHERE id = ?`, id);
    }
  });
  return accepted.students.length + accepted.sessions.length + accepted.attempts.length;
}

export async function runSync(db: SQLiteDatabase): Promise<SyncResult> {
  const base = await apiUrl(db);
  const packs = await refreshPacks(db, base);
  const analysed = await analysePending(db, base);
  const pushed = await pushRecords(db, base);
  return { analysed, pushed, packs };
}

export async function pendingCounts(db: SQLiteDatabase): Promise<{ notes: number; records: number }> {
  const a = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE ai_status = 'pending'");
  const r = await db.getFirstAsync<{ n: number }>(`SELECT
    (SELECT COUNT(*) FROM students WHERE synced = 0) +
    (SELECT COUNT(*) FROM sessions WHERE synced = 0 AND finished_at IS NOT NULL) +
    (SELECT COUNT(*) FROM attempts WHERE synced = 0) AS n`);
  return { notes: a?.n ?? 0, records: r?.n ?? 0 };
}
