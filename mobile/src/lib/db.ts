// On-device SQLite store. Every record is written locally first; `synced = 0` rows are
// pushed by the sync engine when the phone is online. Student names never leave the phone.
import type { SQLiteDatabase } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import seedPacks from './seedPacks.json';
import type { Language, Level, PlacedLevel } from './placement';

export type Student = {
  id: string;
  name: string;
  student_code: string;
  grade: number;
  school_code: string;
  language: Language;
  created_at: string;
  updated_at: string;
  synced: number;
  last_level: number | null;
  last_needs_help: number | null;
};

export type Session = {
  id: string;
  student_id: string;
  language: Language;
  grade: number;
  placed_level: PlacedLevel | null;
  needs_help: number | null;
  started_at: string;
  finished_at: string | null;
  synced: number;
};

export type AiStatus = 'pending' | 'done' | 'failed' | 'skipped';

export type Attempt = {
  id: string;
  session_id: string;
  level: Level;
  items_json: string;
  marks_json: string;
  accuracy: number;
  passed: number;
  duration_sec: number | null;
  audio_uri: string | null;
  ai_status: AiStatus;
  ai_result_json: string | null;
  ai_tries: number;
  created_at: string;
  synced: number;
  asr_transcript: string | null;
  asr_model: string | null;
};

export type InstalledSpeechModel = {
  id: string;
  language: Language;
  dir: string;
  size_bytes: number;
  installed_at: string;
};

export type ContentPack = {
  pack_id: string;
  language: Language;
  grade: number;
  source: 'seed' | 'claude';
  levels: Partial<Record<Level, string[]>>; // only the levels on this language's ladder
};

const SCHEMA_VERSION = 2;

export async function migrate(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version < 1) await migrateV1(db);
  if (version < 2) await migrateV2(db);
}

async function migrateV1(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, student_code TEXT NOT NULL DEFAULT '',
      grade INTEGER NOT NULL, school_code TEXT NOT NULL DEFAULT '', language TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      language TEXT NOT NULL, grade INTEGER NOT NULL, placed_level INTEGER, needs_help INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT, synced INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      level TEXT NOT NULL, items_json TEXT NOT NULL, marks_json TEXT NOT NULL, accuracy REAL NOT NULL,
      passed INTEGER NOT NULL, duration_sec REAL, audio_uri TEXT, ai_status TEXT NOT NULL,
      ai_result_json TEXT, ai_tries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS content_packs (
      language TEXT NOT NULL, grade INTEGER NOT NULL, pack_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
      PRIMARY KEY (language, grade));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_attempts_ai ON attempts(ai_status);
    CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
    PRAGMA user_version = 1;
  `);
}

// v2: speech recognition moved onto the phone. Attempts store the on-device transcript (text only);
// audio is deleted right after transcription and never uploaded.
async function migrateV2(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    ALTER TABLE attempts ADD COLUMN asr_transcript TEXT;
    ALTER TABLE attempts ADD COLUMN asr_model TEXT;
    CREATE TABLE IF NOT EXISTS speech_models (
      id TEXT PRIMARY KEY, language TEXT NOT NULL, dir TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      installed_at TEXT NOT NULL);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

const now = () => new Date().toISOString();

// ---- settings ---------------------------------------------------------------

export async function getSetting(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setSetting(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, value);
}

export async function deviceId(db: SQLiteDatabase): Promise<string> {
  const existing = await getSetting(db, 'device_id');
  if (existing) return existing;
  const id = randomUUID();
  await setSetting(db, 'device_id', id);
  return id;
}

// ---- students ---------------------------------------------------------------

export async function listStudents(db: SQLiteDatabase): Promise<Student[]> {
  return db.getAllAsync<Student>(`
    SELECT s.*,
      (SELECT placed_level FROM sessions WHERE student_id = s.id AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1) AS last_level,
      (SELECT needs_help FROM sessions WHERE student_id = s.id AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1) AS last_needs_help
    FROM students s ORDER BY s.updated_at DESC`);
}

export async function getStudent(db: SQLiteDatabase, id: string): Promise<Student | null> {
  return db.getFirstAsync<Student>('SELECT *, NULL AS last_level, NULL AS last_needs_help FROM students WHERE id = ?', id);
}

export async function addStudent(
  db: SQLiteDatabase,
  s: Pick<Student, 'name' | 'student_code' | 'grade' | 'school_code' | 'language'>,
): Promise<string> {
  const id = randomUUID();
  const t = now();
  await db.runAsync(
    'INSERT INTO students (id, name, student_code, grade, school_code, language, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    id, s.name.trim(), s.student_code.trim(), s.grade, s.school_code.trim(), s.language, t, t,
  );
  return id;
}

// ---- sessions & attempts ----------------------------------------------------

export async function startSession(db: SQLiteDatabase, student: Student): Promise<string> {
  const id = randomUUID();
  await db.runAsync(
    'INSERT INTO sessions (id, student_id, language, grade, started_at) VALUES (?,?,?,?,?)',
    id, student.id, student.language, student.grade, now(),
  );
  return id;
}

export async function finishSession(db: SQLiteDatabase, id: string, placed: PlacedLevel, needsHelp: boolean, studentId: string) {
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE sessions SET placed_level = ?, needs_help = ?, finished_at = ?, synced = 0 WHERE id = ?',
      placed, needsHelp ? 1 : 0, now(), id,
    );
    await db.runAsync('UPDATE students SET updated_at = ? WHERE id = ?', now(), studentId);
  });
}

export async function getSession(db: SQLiteDatabase, id: string): Promise<Session | null> {
  return db.getFirstAsync<Session>('SELECT * FROM sessions WHERE id = ?', id);
}

export async function saveAttempt(
  db: SQLiteDatabase,
  a: {
    session_id: string; level: Level; items: string[]; marks: boolean[]; accuracy: number; passed: boolean;
    duration_sec: number | null; asr_transcript: string | null; asr_model: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  // Every attempt gets a Claude note after sync (teacher marks alone are enough for the pattern).
  await db.runAsync(
    `INSERT INTO attempts (id, session_id, level, items_json, marks_json, accuracy, passed, duration_sec, ai_status, created_at, asr_transcript, asr_model)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, a.session_id, a.level, JSON.stringify(a.items), JSON.stringify(a.marks), a.accuracy, a.passed ? 1 : 0,
    a.duration_sec, 'pending', now(), a.asr_transcript, a.asr_model,
  );
  return id;
}

export async function sessionAttempts(db: SQLiteDatabase, sessionId: string): Promise<Attempt[]> {
  return db.getAllAsync<Attempt>('SELECT * FROM attempts WHERE session_id = ? ORDER BY created_at', sessionId);
}

// ---- content packs ----------------------------------------------------------

export async function getPack(db: SQLiteDatabase, language: Language, grade: number): Promise<ContentPack> {
  const row = await db.getFirstAsync<{ pack_json: string }>(
    'SELECT pack_json FROM content_packs WHERE language = ? AND grade = ?', language, grade,
  );
  const seed = (seedPacks as Record<Language, ContentPack>)[language];
  if (!row) return seed;
  // Packs saved before a level existed (e.g. story) borrow that level from the bundled seed pack.
  const saved = JSON.parse(row.pack_json) as ContentPack;
  const levels = { ...seed.levels };
  for (const [level, items] of Object.entries(saved.levels ?? {})) {
    if (Array.isArray(items) && items.length) levels[level as Level] = items;
  }
  return { ...saved, levels };
}

export async function savePack(db: SQLiteDatabase, pack: ContentPack, grade: number): Promise<void> {
  await db.runAsync(
    'INSERT OR REPLACE INTO content_packs (language, grade, pack_json, fetched_at) VALUES (?,?,?,?)',
    pack.language, grade, JSON.stringify(pack), now(),
  );
}

// ---- on-device speech models ------------------------------------------------

export async function installedSpeechModel(db: SQLiteDatabase, language: Language): Promise<InstalledSpeechModel | null> {
  return db.getFirstAsync<InstalledSpeechModel>('SELECT * FROM speech_models WHERE language = ?', language);
}

export async function listInstalledSpeechModels(db: SQLiteDatabase): Promise<InstalledSpeechModel[]> {
  return db.getAllAsync<InstalledSpeechModel>('SELECT * FROM speech_models');
}

export async function recordSpeechModel(db: SQLiteDatabase, m: Omit<InstalledSpeechModel, 'installed_at'>): Promise<void> {
  await db.runAsync(
    'INSERT OR REPLACE INTO speech_models (id, language, dir, size_bytes, installed_at) VALUES (?,?,?,?,?)',
    m.id, m.language, m.dir, m.size_bytes, now(),
  );
}

export async function forgetSpeechModel(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM speech_models WHERE id = ?', id);
}
