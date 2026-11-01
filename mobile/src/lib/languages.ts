// Reading languages a child can be assessed in (the order of the language switch).
import type { Language } from './placement';

export const GRADE_FILTERS = ['all', 1, 2, 3] as const; // Grades 1-3, or every grade
export type GradeFilter = (typeof GRADE_FILTERS)[number];

export const LANGS: readonly Language[] = ['te', 'hi', 'en'];
