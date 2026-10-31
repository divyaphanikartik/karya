/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, monthGrid, todayISO } from './dates.ts';

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-10-31', 14), '2026-11-14');
  assert.equal(addDays('2026-12-25', 10), '2027-01-04');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // leap year
});

test('todayISO uses the local calendar date', () => {
  assert.equal(todayISO(new Date(2026, 9, 31, 23, 59)), '2026-10-31');
});

test('monthGrid pads to whole Sunday-first weeks', () => {
  const nov = monthGrid(2026, 10); // November 2026 starts on a Sunday
  assert.equal(nov[0], '2026-11-01');
  assert.equal(nov.length % 7, 0);
  const oct = monthGrid(2026, 9); // October 2026 starts on a Thursday
  assert.deepEqual(oct.slice(0, 5), [null, null, null, null, '2026-10-01']);
  assert.equal(oct.filter(Boolean).length, 31);
});
