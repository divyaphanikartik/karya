// Adaptive reading-level placement, modelled on the ASER ladder
// (beginner -> letter -> word -> sentence -> paragraph). Runs entirely on the phone so a
// teacher can place a child with no internet. Thresholds are draft values for review.

export type Language = 'en' | 'hi' | 'te';
export const LEVELS = ['letter', 'word', 'sentence', 'paragraph'] as const;
export type Level = (typeof LEVELS)[number];

/** Placed level: 0 = beginner (not yet letters), 1 = letter ... 4 = paragraph. */
export type PlacedLevel = 0 | 1 | 2 | 3 | 4;

export const ITEMS_PER_LEVEL: Record<Level, number> = { letter: 5, word: 5, sentence: 2, paragraph: 1 };
export const PASS_ACCURACY = 0.8;
export const MAX_ATTEMPTS = 6;

export type AttemptOutcome = { level: Level; passed: boolean };
export type NextStep = { done: false; level: Level } | { done: true; placed: PlacedLevel };

export function startLevel(grade: number): Level {
  return grade <= 2 ? 'sentence' : 'paragraph';
}

/** Level a child is expected to read at the end of their current grade (draft, configurable). */
export function expectedLevel(grade: number): PlacedLevel {
  if (grade <= 1) return 2;
  if (grade === 2) return 3;
  return 4;
}

export function nextStep(grade: number, attempts: AttemptOutcome[]): NextStep {
  if (attempts.length === 0) return { done: false, level: startLevel(grade) };
  const idx = (l: Level) => LEVELS.indexOf(l);
  const passed = new Set(attempts.filter((a) => a.passed).map((a) => idx(a.level)));
  const failed = new Set(attempts.filter((a) => !a.passed).map((a) => idx(a.level)));
  const highestPassed = passed.size ? Math.max(...passed) : -1;
  const last = attempts[attempts.length - 1];
  const i = idx(last.level);

  if (attempts.length >= MAX_ATTEMPTS) return { done: true, placed: (highestPassed + 1) as PlacedLevel };
  if (last.passed) {
    if (i === LEVELS.length - 1 || failed.has(i + 1)) return { done: true, placed: (i + 1) as PlacedLevel };
    return { done: false, level: LEVELS[i + 1] };
  }
  if (i === 0) return { done: true, placed: 0 };
  if (passed.has(i - 1)) return { done: true, placed: i as PlacedLevel };
  return { done: false, level: LEVELS[i - 1] };
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
