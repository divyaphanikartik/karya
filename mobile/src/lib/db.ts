// On-device SQLite store. Every record is written locally first; `synced = 0` rows are pushed by
// the sync engine when the phone is online (to the signed-in teacher's school). Students are shared
// within a school: the school's roster is pulled down so any teacher can assess any child.
import type { SQLiteDatabase } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import seedPacks from './seedPacks.json';
import { REVIEW_AFTER_DAYS, addDays, todayISO } from './dates';
import type { Language, Level, MeaningLevel, PlacedLevel } from './placement';

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
  added_by: string | null;
  last_level: number | null;
  last_needs_help: number | null;
  next_review: string | null; // 'YYYY-MM-DD'; set after each check, editable by the teacher
};

/** Missed items the teacher scheduled for practice on a later day. */
export type PracticePlan = {
  id: string;
  student_id: string;
  level: Level;
  items_json: string;
  due_date: string; // 'YYYY-MM-DD'
  done_at: string | null;
  created_at: string;
  synced: number;
};

export type PracticePlanWithStudent = PracticePlan & { name: string; language: Language; grade: number };

export type PracticeRound = {
  id: string;
  student_id: string;
  level: Level;
  items_json: string;
  marks_json: string;
  fluent: number | null;
  passed: number;
  created_at: string;
};

/** A student as the server's school roster returns it. */
export type RosterStudent = {
  id: string; student_code: string; name: string; grade: number; language: Language; updated_at: string;
  added_by: string | null; placed_level: number | null; needs_help: boolean | null; finished_at: string | null;
  next_review: string | null;
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
  // English meaning check; all null when not asked or skipped.
  meaning_level: MeaningLevel | null;
  meaning_items_json: string | null;
  meaning_marks_json: string | null;
  meaning_can_say: number | null;
};

export type MeaningResult = { level: MeaningLevel; items: string[]; marks: boolean[]; canSay: boolean };

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
  asr_status: 'pending' | 'done' | 'failed' | null;
  fluent: number | null; // paragraph/story: teacher judged the reading fluent (ASER); null elsewhere
};


export type ContentPack = {
  pack_id: string;
  language: Language;
  grade: number;
  source: 'seed' | 'claude';
  levels: Partial<Record<Level, string[]>>; // only the levels on this language's ladder
  // English packs: a sample meaning of each word and sentence in the teacher's app language
  // (meanings.hi['cat'] = 'बिल्ली'), shown as a hint during the meaning check.
  meanings?: Partial<Record<'hi' | 'te', Record<string, string>>>;
  // Practice items (bundled seed packs only): same standards, none of the check's items.
  practice?: Partial<Record<Level, string[]>>;
};

const SCHEMA_VERSION = 9;

export async function migrate(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version < 1) await migrateV1(db);
  if (version < 2) await migrateV2(db);
  if (version < 3) await migrateV3(db);
  if (version < 4) await migrateV4(db);
  if (version < 5) await migrateV5(db);
  if (version < 6) await migrateV6(db);
  if (version < 7) await migrateV7(db);
  if (version < 8) await migrateV8(db);
  if (version < 9) await migrateV9(db);
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
    PRAGMA user_version = 2;
  `);
}

// v3: English meaning check (ASER), stored on the session it followed.
async function migrateV3(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    ALTER TABLE sessions ADD COLUMN meaning_level TEXT;
    ALTER TABLE sessions ADD COLUMN meaning_items_json TEXT;
    ALTER TABLE sessions ADD COLUMN meaning_marks_json TEXT;
    ALTER TABLE sessions ADD COLUMN meaning_can_say INTEGER;
    PRAGMA user_version = 3;
  `);
}

// v4: Hindi/Telugu follow ASER's ladder, which has no sentence level (letter, word, paragraph, story).
// Old placed levels move to the new scale: sentence (3) did not reach the paragraph, so it becomes
// word; paragraph 4 -> 3, story 5 -> 4. Changed sessions upload again so the server matches.
async function migrateV4(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    ALTER TABLE attempts ADD COLUMN fluent INTEGER;
    UPDATE sessions SET placed_level = CASE placed_level WHEN 3 THEN 2 WHEN 4 THEN 3 WHEN 5 THEN 4 END, synced = 0
      WHERE language IN ('hi', 'te') AND placed_level >= 3;
    PRAGMA user_version = 4;
  `);
}

// v5: practice rounds between checks, and each child's next review date. Both stay on the phone.
async function migrateV5(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    ALTER TABLE students ADD COLUMN next_review TEXT;
    CREATE TABLE IF NOT EXISTS practice (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      level TEXT NOT NULL, items_json TEXT NOT NULL, marks_json TEXT NOT NULL, fluent INTEGER,
      passed INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_practice_student ON practice(student_id, created_at);
    PRAGMA user_version = 5;
  `);
}

// v6: practice rounds and review dates sync to the server (counts and dates only); practice items
// come from their own pool, cached here when the server has a Claude-written one.
async function migrateV6(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    ALTER TABLE practice ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS practice_packs (
      language TEXT NOT NULL, grade INTEGER NOT NULL, pack_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
      PRIMARY KEY (language, grade));
    UPDATE students SET synced = 0 WHERE next_review IS NOT NULL;
    PRAGMA user_version = 6;
  `);
}

// v7: practice plans, so the teacher can move "practise these" to a later day.
async function migrateV7(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS practice_plans (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      level TEXT NOT NULL, items_json TEXT NOT NULL, due_date TEXT NOT NULL, done_at TEXT,
      created_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_practice_plans_due ON practice_plans(due_date);
    PRAGMA user_version = 7;
  `);
}

// v8: accounts. Students are shared per school (added_by = the teacher who added the child);
// sessions record which signed-in teacher ran the check.
async function migrateV8(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    ALTER TABLE students ADD COLUMN added_by TEXT;
    ALTER TABLE sessions ADD COLUMN teacher_id TEXT;
    PRAGMA user_version = 8;
  `);
}

// v9: recordings are transcribed on the Karya server. asr_status: 'pending' = the recording (audio_uri)
// is waiting on the phone for a connection; 'done' / 'failed' afterwards; null = no recording.
async function migrateV9(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    ALTER TABLE attempts ADD COLUMN asr_status TEXT;
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

/** A child already on this phone (or pulled from the school roster) with this roll number. */
export async function studentByCode(db: SQLiteDatabase, code: string): Promise<Student | null> {
  return db.getFirstAsync<Student>(
    'SELECT *, NULL AS last_level, NULL AS last_needs_help FROM students WHERE student_code = ? COLLATE NOCASE', code.trim());
}

/**
 * Merge the school roster into this phone. New children are added as already-synced rows; children
 * edited on this phone and not yet synced keep the local edit. The latest server-side check is stored
 * as a summary session so the home screen shows levels found by other teachers too.
 */
export async function mergeRoster(db: SQLiteDatabase, roster: RosterStudent[]): Promise<number> {
  let added = 0;
  await db.withTransactionAsync(async () => {
    for (const r of roster) {
      const local = await db.getFirstAsync<{ id: string; synced: number }>(
        'SELECT id, synced FROM students WHERE id = ? OR student_code = ? COLLATE NOCASE', r.id, r.student_code);
      if (!local) {
        await db.runAsync(
          `INSERT INTO students (id, name, student_code, grade, school_code, language, created_at, updated_at, synced, added_by, next_review)
           VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
          r.id, r.name, r.student_code, r.grade, '', r.language, r.updated_at, r.updated_at, r.added_by, r.next_review);
        added++;
      } else if (local.id !== r.id) {
        await remapStudentId(db, local.id, r.id); // same child added on two phones: adopt the server's id
      } else if (local.synced) {
        await db.runAsync('UPDATE students SET name = ?, grade = ?, language = ?, added_by = ?, next_review = ? WHERE id = ?',
          r.name, r.grade, r.language, r.added_by, r.next_review, r.id);
      }
      if (r.placed_level != null && r.finished_at) {
        await db.runAsync(
          `INSERT OR IGNORE INTO sessions (id, student_id, language, grade, placed_level, needs_help, started_at, finished_at, synced)
           VALUES (?,?,?,?,?,?,?,?,1)`,
          `server-${r.id}-${r.finished_at}`, r.id, r.language, r.grade, r.placed_level, r.needs_help ? 1 : 0, r.finished_at, r.finished_at);
      }
    }
  });
  return added;
}

/** Re-point a child (and their checks) from this phone's id to the id the server already uses. */
export async function remapStudentId(db: SQLiteDatabase, fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const target = await db.getFirstAsync<{ id: string }>('SELECT id FROM students WHERE id = ?', toId);
  if (!target) {
    await db.runAsync(
      `INSERT INTO students (id, name, student_code, grade, school_code, language, created_at, updated_at, synced, added_by, next_review)
       SELECT ?, name, student_code, grade, school_code, language, created_at, updated_at, 1, added_by, next_review FROM students WHERE id = ?`,
      toId, fromId);
  }
  // Checks, practice rounds and practice plans all follow the child to the school's record.
  for (const table of ['sessions', 'practice', 'practice_plans']) {
    await db.runAsync(`UPDATE ${table} SET student_id = ? WHERE student_id = ?`, toId, fromId);
  }
  await db.runAsync('DELETE FROM students WHERE id = ?', fromId);
}

/** Remove every child record from this phone (used when a different school signs in). */
export async function clearChildData(db: SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const table of ['attempts', 'practice', 'practice_plans', 'sessions', 'students']) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
  });
}

// ---- sessions & attempts ----------------------------------------------------

export async function startSession(db: SQLiteDatabase, student: Student, teacherId: string | null): Promise<string> {
  const id = randomUUID();
  await db.runAsync(
    'INSERT INTO sessions (id, student_id, language, grade, started_at, teacher_id) VALUES (?,?,?,?,?,?)',
    id, student.id, student.language, student.grade, now(), teacherId,
  );
  return id;
}

export async function finishSession(
  db: SQLiteDatabase, id: string, placed: PlacedLevel, needsHelp: boolean, studentId: string, meaning: MeaningResult | null,
) {
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE sessions SET placed_level = ?, needs_help = ?, finished_at = ?, synced = 0,
         meaning_level = ?, meaning_items_json = ?, meaning_marks_json = ?, meaning_can_say = ? WHERE id = ?`,
      placed, needsHelp ? 1 : 0, now(),
      meaning?.level ?? null, meaning ? JSON.stringify(meaning.items) : null,
      meaning ? JSON.stringify(meaning.marks) : null, meaning ? (meaning.canSay ? 1 : 0) : null, id,
    );
    // Each check schedules the next one; the teacher can move it on the result screen or calendar.
    await db.runAsync('UPDATE students SET updated_at = ?, next_review = ?, synced = 0 WHERE id = ?',
      now(), addDays(todayISO(), REVIEW_AFTER_DAYS), studentId);
  });
}

export async function getSession(db: SQLiteDatabase, id: string): Promise<Session | null> {
  return db.getFirstAsync<Session>('SELECT * FROM sessions WHERE id = ?', id);
}

export async function saveAttempt(
  db: SQLiteDatabase,
  a: {
    session_id: string; level: Level; items: string[]; marks: boolean[]; accuracy: number; passed: boolean;
    duration_sec: number | null; asr_transcript: string | null; asr_model: string | null; fluent: boolean | null;
    /** A recording still waiting for the server (offline); transcribed and deleted at the next sync. */
    pending_audio_uri?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const asrStatus = a.pending_audio_uri ? 'pending' : a.asr_transcript != null ? 'done' : null;
  // Every attempt gets a Claude note after sync (teacher marks alone are enough for the pattern); with
  // a recording, the note waits for the transcript so Claude sees both.
  await db.runAsync(
    `INSERT INTO attempts (id, session_id, level, items_json, marks_json, accuracy, passed, duration_sec, ai_status, created_at,
       asr_transcript, asr_model, fluent, audio_uri, asr_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, a.session_id, a.level, JSON.stringify(a.items), JSON.stringify(a.marks), a.accuracy, a.passed ? 1 : 0,
    a.duration_sec, 'pending', now(), a.asr_transcript, a.asr_model, a.fluent == null ? null : a.fluent ? 1 : 0,
    a.pending_audio_uri ?? null, asrStatus,
  );
  return id;
}

export async function sessionAttempts(db: SQLiteDatabase, sessionId: string): Promise<Attempt[]> {
  return db.getAllAsync<Attempt>('SELECT * FROM attempts WHERE session_id = ? ORDER BY created_at', sessionId);
}

/** The child's most recent finished check, or null if they have never been checked. */
export async function latestSession(db: SQLiteDatabase, studentId: string): Promise<Session | null> {
  return db.getFirstAsync<Session>(
    'SELECT * FROM sessions WHERE student_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1', studentId,
  );
}

// ---- practice and review dates ----------------------------------------------

export async function savePractice(
  db: SQLiteDatabase,
  p: { student_id: string; level: Level; items: string[]; marks: boolean[]; fluent: boolean | null; passed: boolean },
): Promise<void> {
  await db.runAsync(
    'INSERT INTO practice (id, student_id, level, items_json, marks_json, fluent, passed, created_at) VALUES (?,?,?,?,?,?,?,?)',
    randomUUID(), p.student_id, p.level, JSON.stringify(p.items), JSON.stringify(p.marks),
    p.fluent == null ? null : p.fluent ? 1 : 0, p.passed ? 1 : 0, now(),
  );
}

/** Levels the child has passed in practice since a time (normally their last check). */
export async function practicePassedSince(db: SQLiteDatabase, studentId: string, since: string): Promise<Level[]> {
  const rows = await db.getAllAsync<{ level: Level }>(
    'SELECT DISTINCT level FROM practice WHERE student_id = ? AND passed = 1 AND created_at > ?', studentId, since,
  );
  return rows.map((r) => r.level);
}

export async function practiceRoundsSince(db: SQLiteDatabase, studentId: string, level: Level, since: string): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM practice WHERE student_id = ? AND level = ? AND created_at > ?', studentId, level, since,
  );
  return row?.n ?? 0;
}

/**
 * Schedule items for practice on a later day. A child has at most one open plan per level: scheduling
 * again moves that plan (with the latest missed items) instead of adding another.
 */
export async function schedulePractice(
  db: SQLiteDatabase, p: { student_id: string; level: Level; items: string[]; due_date: string },
): Promise<void> {
  const open = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM practice_plans WHERE student_id = ? AND level = ? AND done_at IS NULL', p.student_id, p.level,
  );
  if (open) {
    await db.runAsync('UPDATE practice_plans SET items_json = ?, due_date = ?, synced = 0 WHERE id = ?',
      JSON.stringify(p.items), p.due_date, open.id);
  } else {
    await db.runAsync(
      'INSERT INTO practice_plans (id, student_id, level, items_json, due_date, created_at) VALUES (?,?,?,?,?,?)',
      randomUUID(), p.student_id, p.level, JSON.stringify(p.items), p.due_date, now(),
    );
  }
}

/** Open practice plans with the child's name, soonest first. */
export async function listPracticePlans(db: SQLiteDatabase): Promise<PracticePlanWithStudent[]> {
  return db.getAllAsync<PracticePlanWithStudent>(`
    SELECT p.*, s.name, s.language, s.grade FROM practice_plans p JOIN students s ON s.id = p.student_id
    WHERE p.done_at IS NULL ORDER BY p.due_date, s.name`);
}

export async function getPracticePlan(db: SQLiteDatabase, id: string): Promise<PracticePlan | null> {
  return db.getFirstAsync<PracticePlan>('SELECT * FROM practice_plans WHERE id = ?', id);
}

/** A plan is done once its round has been checked, passed or not. */
export async function completePracticePlan(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('UPDATE practice_plans SET done_at = ?, synced = 0 WHERE id = ?', now(), id);
}

export async function setNextReview(db: SQLiteDatabase, studentId: string, date: string): Promise<void> {
  // synced = 0 uploads the new date with the student record.
  await db.runAsync('UPDATE students SET next_review = ?, synced = 0 WHERE id = ?', date, studentId);
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
  // Seed meanings cover any seed items; a server pack's own meanings win for its items.
  const meanings: ContentPack['meanings'] = {};
  for (const lang of ['hi', 'te'] as const) {
    meanings[lang] = { ...seed.meanings?.[lang], ...saved.meanings?.[lang] };
  }
  return { ...saved, levels, meanings };
}

/**
 * Practice items for one level: the server's Claude-written practice pack if one is cached, else the
 * bundled practice pool. Falls back to the check items only if a level has no practice items at all.
 */
export async function getPracticeItems(db: SQLiteDatabase, language: Language, grade: number, level: Level): Promise<string[]> {
  const row = await db.getFirstAsync<{ pack_json: string }>(
    'SELECT pack_json FROM practice_packs WHERE language = ? AND grade = ?', language, grade,
  );
  const saved = row ? (JSON.parse(row.pack_json) as ContentPack).levels?.[level] : undefined;
  if (saved?.length) return saved;
  const seed = (seedPacks as Record<Language, ContentPack>)[language];
  const check = (await getPack(db, language, grade)).levels[level] ?? [];
  const pool = seed.practice?.[level] ?? [];
  // A Claude-written check pack may happen to use a bundled practice item; keep those out of practice.
  const fresh = pool.filter((item) => !check.includes(item));
  return fresh.length ? fresh : pool.length ? pool : check;
}

export async function savePracticePack(db: SQLiteDatabase, pack: ContentPack, grade: number): Promise<void> {
  await db.runAsync(
    'INSERT OR REPLACE INTO practice_packs (language, grade, pack_json, fetched_at) VALUES (?,?,?,?)',
    pack.language, grade, JSON.stringify(pack), now(),
  );
}

export async function savePack(db: SQLiteDatabase, pack: ContentPack, grade: number): Promise<void> {
  await db.runAsync(
    'INSERT OR REPLACE INTO content_packs (language, grade, pack_json, fetched_at) VALUES (?,?,?,?)',
    pack.language, grade, JSON.stringify(pack), now(),
  );
}

