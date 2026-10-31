// Adaptive reading-level placement for government and low-income schools, modelled on the ASER
// tools and NIPUN Bharat goals. Runs entirely on the phone so a teacher can place a child with no
// internet. Thresholds and start levels are draft values for review by early-literacy educators.
//
// Each level is the same standard for every grade, so results compare across grades. The grade
// and language decide where the check starts and what is expected by the end of the year.

export type Language = 'en' | 'hi' | 'te';
/** Every level any ladder uses. In English, 'capital' is capital letters and 'letter' small letters. */
export const LEVELS = ['capital', 'letter', 'word', 'sentence', 'paragraph', 'story'] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Reading ladder per language, following ASER.
 * Hindi and Telugu (the state language children learn to read first): letter -> word ->
 * sentence -> paragraph (Std 1 text) -> story (Std 2 text).
 * English is a second language for most of these children, and ASER's English tool stops at simple
 * sentences: capital letters -> small letters -> 3-letter words -> 4-5 word sentences.
 */
export const LADDERS: Record<Language, readonly Level[]> = {
  hi: ['letter', 'word', 'sentence', 'paragraph', 'story'],
  te: ['letter', 'word', 'sentence', 'paragraph', 'story'],
  en: ['capital', 'letter', 'word', 'sentence'],
};

/** Placed level: 0 = beginner, n = the n-th step of the language's ladder (top = whole ladder read). */
export type PlacedLevel = number;

export const ITEMS_PER_LEVEL: Record<Level, number> = { capital: 5, letter: 5, word: 5, sentence: 2, paragraph: 1, story: 1 };
export const PASS_ACCURACY = 0.8;
export const MAX_ATTEMPTS = 6;

export type AttemptOutcome = { level: Level; passed: boolean };
export type NextStep = { done: false; level: Level } | { done: true; placed: PlacedLevel };

const gradeIndex = (grade: number) => Math.min(Math.max(Math.round(grade), 1), 5) - 1;

/**
 * Start where most government-school children of that grade can succeed, then climb, so a child's
 * first item is not a failure and the check stays short. Based on ASER distributions: in Grade 3
 * about half of rural children read words or less in their state language (ASER 2024), and about
 * two-thirds read only small letters or less in English (ASER 2022).
 */
const START: Record<Language, readonly Level[]> = {
  hi: ['letter', 'word', 'sentence', 'sentence', 'paragraph'],
  te: ['letter', 'word', 'sentence', 'sentence', 'paragraph'],
  en: ['capital', 'capital', 'letter', 'letter', 'word'],
};

export function startLevel(grade: number, language: Language): Level {
  return START[language][gradeIndex(grade)];
}

/**
 * Level a child should read by the end of their grade. Kept at the official goals, not lowered to
 * what is typical, so the gap stays visible. Hindi/Telugu follow NIPUN Bharat: Grade 1 short
 * sentences, Grade 2 Std 1 paragraph, Grade 3 and up Std 2 story. English has no national grade
 * goal; these are drafts: Grade 1 capitals, Grade 2 small letters, Grade 3 words, Grade 4-5 sentences.
 */
const EXPECTED: Record<Language, readonly PlacedLevel[]> = {
  hi: [3, 4, 5, 5, 5],
  te: [3, 4, 5, 5, 5],
  en: [1, 2, 3, 4, 4],
};

export function expectedLevel(grade: number, language: Language): PlacedLevel {
  return EXPECTED[language][gradeIndex(grade)];
}

/** The ladder step a child should practise next, or null at the top of the ladder. */
export function nextGoal(placed: PlacedLevel, language: Language): Level | null {
  return LADDERS[language][placed] ?? null;
}

/** Ladder step for a placed level (null for beginner). */
export function placedStep(placed: PlacedLevel, language: Language): Level | null {
  return placed > 0 ? LADDERS[language][placed - 1] ?? null : null;
}

/** Levels where reading speed is timed and shown. */
export const TIMED_LEVELS: readonly Level[] = ['paragraph', 'story'];

/**
 * NIPUN Bharat end-of-grade reading speed for the state language, in words correct per minute:
 * Grade 2 45-60, Grade 3 at least 60 (also used for Grades 4-5). None for Grade 1 or for English.
 */
export function speedTarget(grade: number, language: Language): { min: number; max: number | null } | null {
  if (language === 'en' || grade <= 1) return null;
  if (grade === 2) return { min: 45, max: 60 };
  return { min: 60, max: null };
}

/** Words read correctly per minute, or null without a usable time. */
export function wordsPerMinute(marks: boolean[], seconds: number | null): number | null {
  if (!seconds || seconds < 1) return null;
  return Math.round((marks.filter(Boolean).length * 60) / seconds);
}

export function nextStep(grade: number, language: Language, attempts: AttemptOutcome[]): NextStep {
  if (attempts.length === 0) return { done: false, level: startLevel(grade, language) };
  const ladder = LADDERS[language];
  const idx = (l: Level) => ladder.indexOf(l);
  const passed = new Set(attempts.filter((a) => a.passed).map((a) => idx(a.level)));
  const failed = new Set(attempts.filter((a) => !a.passed).map((a) => idx(a.level)));
  const highestPassed = passed.size ? Math.max(...passed) : -1;
  const last = attempts[attempts.length - 1];
  const i = idx(last.level);

  if (attempts.length >= MAX_ATTEMPTS) return { done: true, placed: highestPassed + 1 };
  if (last.passed) {
    if (i === ladder.length - 1 || failed.has(i + 1)) return { done: true, placed: i + 1 };
    return { done: false, level: ladder[i + 1] };
  }
  if (i === 0) return { done: true, placed: 0 };
  if (passed.has(i - 1)) return { done: true, placed: i };
  return { done: false, level: ladder[i - 1] };
}

export function accuracy(marks: boolean[]): number {
  return marks.length ? marks.filter(Boolean).length / marks.length : 0;
}

export function isPassed(marks: boolean[]): boolean {
  return accuracy(marks) >= PASS_ACCURACY;
}

/** Pick items for one attempt, preferring ones this child has not seen in the session. */
export function pickItems(pool: string[], level: Level, used: Set<string>): string[] {
  const fresh = pool.filter((p) => !used.has(p));
  const source = fresh.length >= ITEMS_PER_LEVEL[level] ? fresh : pool;
  const shuffled = [...source].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, ITEMS_PER_LEVEL[level]);
}

// Must match assessment_v2.tokenize on the server: the server checks one mark per token.
const SPLIT = /[\s.,!?;:"'।॥()\-–—]+/u;

/** Display tokens (original case). Count and order match the server's tokenizer. */
export function tokens(items: string[]): string[] {
  return items.flatMap((item) => item.normalize('NFC').split(SPLIT).filter(Boolean));
}

const WORD = /[^\s.,!?;:"'।॥()\-–—]+/gu;

/**
 * The same tokens as tokens([item]), but with the punctuation around each word kept for display
 * ("है।", "dog."), so a paragraph reads like a paragraph while each word stays one tap target.
 * Punctuation before a space goes with the word before it; punctuation after a space goes with
 * the next word.
 */
export function displayTokens(item: string): string[] {
  const text = item.normalize('NFC');
  const words = [...text.matchAll(WORD)];
  return words.map((m, k) => {
    const prevEnd = k === 0 ? 0 : words[k - 1].index! + words[k - 1][0].length;
    const nextStart = k === words.length - 1 ? text.length : words[k + 1].index!;
    const before = text.slice(prevEnd, m.index);
    const after = text.slice(m.index! + m[0].length, nextStart);
    // With no space in between ("don't"), the punctuation already went to the previous word.
    const lead = k === 0 ? before : /\s/.test(before) ? before.slice(before.search(/\S*$/)) : '';
    const space = after.search(/\s/);
    const trail = k === words.length - 1 || space < 0 ? after : after.slice(0, space);
    return (lead + m[0] + trail).trim();
  });
}
