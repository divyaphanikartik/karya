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
 * Hindi and Telugu (the state language children learn to read first), ASER's reading tool:
 * letter -> word -> paragraph (Std 1 text) -> story (Std 2 text). There is no separate sentence level.
 * English is a second language for most of these children, and ASER's English tool stops at simple
 * sentences: capital letters -> small letters -> 3-letter words -> 4-5 word sentences.
 */
export const LADDERS: Record<Language, readonly Level[]> = {
  hi: ['letter', 'word', 'paragraph', 'story'],
  te: ['letter', 'word', 'paragraph', 'story'],
  en: ['capital', 'letter', 'word', 'sentence'],
};

/** Placed level: 0 = beginner, n = the n-th step of the language's ladder (top = whole ladder read). */
export type PlacedLevel = number;

/**
 * Items shown in one attempt, as in ASER: 5 letters or words, 4 English sentences (only English has a
 * sentence level), one paragraph or story.
 */
export const ITEMS_PER_LEVEL: Record<Level, number> = { capital: 5, letter: 5, word: 5, sentence: 4, paragraph: 1, story: 1 };
export const PASS_ACCURACY = 0.8;
const EN_SENTENCES_TO_PASS = 2;
/** ASER paragraph and story: at most 3 mistakes, read fluently (like sentences, even if slowly). */
export const TEXT_MAX_MISTAKES = 3;
/** Levels where the teacher also judges fluency (ASER: "like sentences, not a string of words"). */
export const FLUENCY_LEVELS: readonly Level[] = ['paragraph', 'story'];
export const MAX_ATTEMPTS = 6;
export const MAX_GRADE = 3; // the app covers Grades 1-3

export type AttemptOutcome = { level: Level; passed: boolean };
export type NextStep = { done: false; level: Level } | { done: true; placed: PlacedLevel };

const gradeIndex = (grade: number) => Math.min(Math.max(Math.round(grade), 1), MAX_GRADE) - 1;

/**
 * Start where ASER's tools start, whatever the grade. Hindi/Telugu: at the paragraph, then down to
 * words and letters or up to the story. English: at capital letters, then up through small letters
 * and words to sentences, stopping at the first level the child cannot read.
 */
const START: Record<Language, readonly Level[]> = {
  hi: ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph'],
  te: ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph'],
  en: ['capital', 'capital', 'capital', 'capital', 'capital'],
};

export function startLevel(grade: number, language: Language): Level {
  return START[language][gradeIndex(grade)];
}

/**
 * Level a child should read by the end of their grade. Kept at the official goals, not lowered to
 * what is typical, so the gap stays visible. Hindi/Telugu follow what ASER's texts stand for: the
 * paragraph is Std 1 text (Grade 1) and the story Std 2 text (Grade 2 and up). English has no
 * national grade goal; these are drafts: Grade 1 capitals, Grade 2 small letters, Grade 3 words,
 * Grade 4-5 sentences.
 */
const EXPECTED: Record<Language, readonly PlacedLevel[]> = {
  hi: [3, 4, 4, 4, 4],
  te: [3, 4, 4, 4, 4],
  en: [1, 2, 3, 4, 4],
};

export function expectedLevel(grade: number, language: Language): PlacedLevel {
  return EXPECTED[language][gradeIndex(grade)];
}

/** The ladder step a child should practise next, or null at the top of the ladder. */
export function nextGoal(placed: PlacedLevel, language: Language): Level | null {
  return LADDERS[language][placed] ?? null;
}

/**
 * The level to practise: the next step above the placed level, skipping steps already passed in
 * practice since that check. Null when the child has reached the top of the ladder.
 */
export function practiceTarget(placed: PlacedLevel, language: Language, passedInPractice: ReadonlySet<Level>): Level | null {
  const ladder = LADDERS[language];
  for (let i = placed; i < ladder.length; i++) if (!passedInPractice.has(ladder[i])) return ladder[i];
  return null;
}

/** Ladder step for a placed level (null for beginner). */
export function placedStep(placed: PlacedLevel, language: Language): Level | null {
  return placed > 0 ? LADDERS[language][placed - 1] ?? null : null;
}

/** Levels where reading speed is timed and shown. */
export const TIMED_LEVELS: readonly Level[] = ['paragraph', 'story'];

/**
 * NIPUN Bharat end-of-grade reading speed for the state language, in words correct per minute:
 * Grade 2 45-60, Grade 3 at least 60. None for Grade 1 or for English.
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

/** Items whose every word the teacher marked correct. marks has one entry per token of items. */
export function itemsReadCorrectly(items: string[], marks: boolean[]): string[] {
  let at = 0;
  return items.filter((item) => {
    const n = tokens([item]).length;
    const ok = marks.slice(at, at + n).every(Boolean);
    at += n;
    return ok;
  });
}

/**
 * Items to go over again: those with any misread word. For letters and words these are exactly the
 * missed items; for a sentence, paragraph or story it is the whole text that had a slip.
 */
export function itemsToRepeat(items: string[], marks: boolean[]): string[] {
  const read = new Set(itemsReadCorrectly(items, marks));
  return items.filter((item) => !read.has(item));
}

/** A practice round that starts with planned items and is topped up from the pool to a full set. */
export function plannedRound(planned: string[], pool: string[], count: number): string[] {
  const fill = pool.filter((p) => !planned.includes(p)).sort(() => Math.random() - 0.5);
  return [...planned, ...fill].slice(0, count);
}

/**
 * ASER's rules: letters and words, at least 4 of 5 (80%); paragraph and story, at most 3 mistakes
 * and read fluently (fluent is the teacher's judgement); English sentences, at least 2 of the 4
 * read with no mistakes.
 */
export function isPassed(level: Level, items: string[], marks: boolean[], fluent = false): boolean {
  if (level === 'sentence') return itemsReadCorrectly(items, marks).length >= EN_SENTENCES_TO_PASS;
  if (FLUENCY_LEVELS.includes(level)) return fluent && marks.filter((ok) => !ok).length <= TEXT_MAX_MISTAKES;
  return accuracy(marks) >= PASS_ACCURACY;
}

/** Pick count items for one attempt, preferring ones this child has not seen in the session. */
export function pickItems(pool: string[], count: number, used: Set<string>): string[] {
  const fresh = pool.filter((p) => !used.has(p));
  const source = fresh.length >= count ? fresh : pool;
  const shuffled = [...source].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// ---- English meaning check (ASER English tool, part 2) ----------------------------------------
// After reading, a child at word level is asked the meaning of the words they read correctly, and a
// child at sentence level the meaning of the sentences they read correctly (never both), in their
// own language. Pointing to an object counts for a word; explaining the main words counts for a
// sentence. It is reported as "can say" / "cannot say" and does not change the reading level.

export type MeaningLevel = 'word' | 'sentence';

/** Meanings needed for "can say": at least 4 words or at least 2 sentences. */
export const MEANING_TO_PASS: Record<MeaningLevel, number> = { word: 4, sentence: 2 };

/** Which meaning check a child gets after placement, or null (not English, or below word level). */
export function meaningLevel(placed: PlacedLevel, language: Language): MeaningLevel | null {
  if (language !== 'en') return null;
  const step = placedStep(placed, language);
  return step === 'word' || step === 'sentence' ? step : null;
}

export function canSayMeaning(level: MeaningLevel, explained: boolean[]): boolean {
  return explained.filter(Boolean).length >= MEANING_TO_PASS[level];
}

// Must match assessment_v2.tokenize on the server: the server checks one mark per token.
const SPLIT = /[\s.,!?;:"'“”‘’।॥()\-–—]+/u;

/** Display tokens (original case). Count and order match the server's tokenizer. */
export function tokens(items: string[]): string[] {
  return items.flatMap((item) => item.normalize('NFC').split(SPLIT).filter(Boolean));
}

const WORD = /[^\s.,!?;:"'“”‘’।॥()\-–—]+/gu;

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
