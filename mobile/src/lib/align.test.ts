/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heardAsWritten } from './align.ts';
import { tokens } from './placement.ts';

test('substitution marks only the misread word', () => {
  assert.deepEqual(heardAsWritten(tokens(['राम घर जा रहा है।']), tokens(['राम घर गया रहा है'])), [true, true, false, true, true]);
});

test('skipped word does not shift later words', () => {
  assert.deepEqual(heardAsWritten(['the', 'cat', 'is', 'on', 'mat'], ['the', 'bat', 'is', 'mat', 'now']), [true, false, true, false, true]);
});

test('case-insensitive for English, exact for Indic vowel signs', () => {
  assert.deepEqual(heardAsWritten(['Ship'], ['ship']), [true]);
  assert.deepEqual(heardAsWritten(['किताब'], ['कीताब']), [false]);
  assert.deepEqual(heardAsWritten(['కిటికీ'], ['కిటికి']), [false]);
});

test('nothing heard flags every word', () => {
  assert.deepEqual(heardAsWritten(['a', 'b'], []), [false, false]);
});

test('a swapped pair is flagged as two misreads, not one skipped item', () => {
  assert.deepEqual(heardAsWritten(['m', 'd', 'g', 'b', 's'], ['m', 'd', 'b', 'g', 's', 'the']), [true, true, false, false, true]);
});
