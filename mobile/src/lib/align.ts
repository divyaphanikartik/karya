// Word alignment between the expected text and what the on-device speech model heard.
// Mirrors assessment_v2.align on the server: substitution costs 1.5 (< skip + insert = 2), so one
// misread word stays a substitution and a skipped word doesn't shift every later word.

const normal = (w: string) => w.normalize('NFC').toLowerCase();

/** For each expected token: true if the speech model heard it as written. */
/** Two neighbouring items read in each other's place (G B heard as B G). */
const swapped = (expected: string[], heard: string[], i: number, j: number) =>
  i >= 2 && j >= 2 && normal(expected[i - 1]) !== normal(expected[i - 2])
  && normal(expected[i - 1]) === normal(heard[j - 2]) && normal(expected[i - 2]) === normal(heard[j - 1]);

export function heardAsWritten(expected: string[], heard: string[]): boolean[] {
  const n = expected.length, m = heard.length, sub = 1.5;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = normal(expected[i - 1]) === normal(heard[j - 1]) ? 0 : sub;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (swapped(expected, heard, i, j)) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + sub);
    }
  }
  const ok = new Array<boolean>(n).fill(false);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (swapped(expected, heard, i, j) && d[i][j] === d[i - 2][j - 2] + sub) {
      i -= 2; j -= 2; // both flagged (left false)
      continue;
    }
    const same = i > 0 && j > 0 && normal(expected[i - 1]) === normal(heard[j - 1]);
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (same ? 0 : sub)) {
      ok[i - 1] = same;
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return ok;
}
