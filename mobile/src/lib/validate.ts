// Input checks for the Add student form.

// Latin, Devanagari and Telugu letters and vowel signs (their digit ranges are left out), the
// zero-width joiners Indic names can need, then space . ' - between letters.
const LETTER = 'A-Za-z\\u0900-\\u0963\\u0971-\\u097F\\u0C00-\\u0C65\\u0C70-\\u0C7F\\u200C\\u200D';
const NAME = new RegExp(`^[${LETTER}]+(?:[ .'-]+[${LETTER}]+)*\\.?$`);

/** Collapse repeated spaces; used before validating and saving. */
export function cleanName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** True if the name has letters only (any of the three scripts), no digits or symbols. */
export function isValidName(name: string): boolean {
  return NAME.test(cleanName(name));
}
