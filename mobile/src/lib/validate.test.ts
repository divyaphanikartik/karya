/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, isValidName } from './validate.ts';

test('accepts names in all three scripts', () => {
  for (const name of ['Ravi Kumar', 'K. Lakshmi', "D'Souza", 'मीना कुमारी', 'రాము', 'లక్ష్మీ దేవి']) {
    assert.equal(isValidName(name), true, name);
  }
});

test('rejects digits in any script, symbols and empty names', () => {
  for (const name of ['Ravi2', '12345', 'मीना १', 'రాము ౧', 'Ravi@', '', '   ', '-']) {
    assert.equal(isValidName(name), false, name);
  }
});

test('cleanName collapses spaces', () => {
  assert.equal(cleanName('  Ravi   Kumar '), 'Ravi Kumar');
});
