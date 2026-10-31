// Calendar dates for review planning, as local 'YYYY-MM-DD' strings (no time zone surprises: a review
// is due on a school day, not at an instant).

/** Default gap before a child's next reading check; the teacher can change each date. */
export const REVIEW_AFTER_DAYS = 14;

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO(now = new Date()): string {
  return toISODate(now);
}

export function addDays(iso: string, days: number): string {
  const d = fromISODate(iso);
  return toISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/** Days of one month for a Sunday-first grid: null pads the first and last weeks. */
export function monthGrid(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array(first).fill(null);
  for (let d = 1; d <= days; d++) cells.push(toISODate(new Date(year, month, d)));
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** 'Nov 14, 2026' style, in the teacher's app language where the device supports it. */
export function formatDate(iso: string, locale: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  try {
    return fromISODate(iso).toLocaleDateString(locale, options);
  } catch {
    return iso;
  }
}
