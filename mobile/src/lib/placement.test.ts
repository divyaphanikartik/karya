/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LADDERS, displayTokens, expectedLevel, isPassed, nextGoal, nextStep, pickItems, placedStep, speedTarget, tokens, wordsPerMinute,
} from './placement.ts';

test('displayTokens keeps punctuation and matches tokens one to one', () => {
  const cases: [string, string[]][] = [
    ['मीना के पास एक गाय है। गाय का रंग सफ़ेद है।', ['मीना', 'के', 'पास', 'एक', 'गाय', 'है।', 'गाय', 'का', 'रंग', 'सफ़ेद', 'है।']],
    ['Ravi has a dog. "Come," he said!', ['Ravi', 'has', 'a', 'dog.', '"Come,"', 'he', 'said!']],
    ["Don't run.", ["Don'", 't', 'run.']],
    ['ఇది నా పుస్తకం.', ['ఇది', 'నా', 'పుస్తకం.']],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(displayTokens(text), want);
    assert.equal(displayTokens(text).length, tokens([text]).length);
  }
});

test('state language: start levels follow government-school reality', () => {
  assert.deepEqual(nextStep(1, 'hi', []), { done: false, level: 'letter' });
  assert.deepEqual(nextStep(2, 'te', []), { done: false, level: 'word' });
  assert.deepEqual(nextStep(3, 'hi', []), { done: false, level: 'sentence' });
  assert.deepEqual(nextStep(5, 'te', []), { done: false, level: 'paragraph' });
});

test('English: separate ASER ladder from capital letters to sentences', () => {
  assert.deepEqual(LADDERS.en, ['capital', 'letter', 'word', 'sentence']);
  assert.deepEqual(nextStep(1, 'en', []), { done: false, level: 'capital' });
  assert.deepEqual(nextStep(3, 'en', []), { done: false, level: 'letter' });
  assert.deepEqual(nextStep(5, 'en', []), { done: false, level: 'word' });
  // Passing sentences is the top of the English ladder.
  assert.deepEqual(nextStep(5, 'en', [{ level: 'word', passed: true }, { level: 'sentence', passed: true }]), { done: true, placed: 4 });
  // Failing capitals: beginner.
  assert.deepEqual(nextStep(1, 'en', [{ level: 'capital', passed: false }]), { done: true, placed: 0 });
  // Knows capitals but not small letters.
  assert.deepEqual(nextStep(3, 'en', [{ level: 'letter', passed: false }, { level: 'capital', passed: true }]), { done: true, placed: 1 });
});

test('pass climbs; failing the level above places at the passed level', () => {
  assert.deepEqual(nextStep(1, 'hi', [{ level: 'letter', passed: true }]), { done: false, level: 'word' });
  assert.deepEqual(nextStep(2, 'hi', [{ level: 'word', passed: true }, { level: 'sentence', passed: false }]), { done: true, placed: 2 });
});

test('passing the story places at the top of the state-language ladder', () => {
  const climb = [{ level: 'paragraph', passed: true }, { level: 'story', passed: true }] as const;
  assert.deepEqual(nextStep(5, 'te', [...climb]), { done: true, placed: 5 });
});

test('fail moves down until a pass; failing letters places as beginner', () => {
  assert.deepEqual(nextStep(3, 'hi', [{ level: 'sentence', passed: false }]), { done: false, level: 'word' });
  const all = [{ level: 'sentence', passed: false }, { level: 'word', passed: false }, { level: 'letter', passed: false }] as const;
  assert.deepEqual(nextStep(3, 'hi', [...all]), { done: true, placed: 0 });
});

test('expected levels keep the official goals; next goal is one step up', () => {
  assert.equal(expectedLevel(1, 'hi'), 3); // sentence
  assert.equal(expectedLevel(2, 'te'), 4); // paragraph
  assert.equal(expectedLevel(3, 'hi'), 5); // story
  assert.equal(expectedLevel(3, 'en'), 3); // words
  assert.equal(expectedLevel(5, 'en'), 4); // sentences
  assert.equal(nextGoal(0, 'en'), 'capital');
  assert.equal(nextGoal(2, 'hi'), 'sentence');
  assert.equal(nextGoal(5, 'hi'), null);
  assert.equal(placedStep(2, 'en'), 'letter');
});

test('reading speed and NIPUN targets (state language only)', () => {
  assert.equal(wordsPerMinute([true, true, true, false], 4), 45);
  assert.equal(wordsPerMinute([true], null), null);
  assert.equal(speedTarget(1, 'hi'), null);
  assert.deepEqual(speedTarget(2, 'te'), { min: 45, max: 60 });
  assert.deepEqual(speedTarget(4, 'hi'), { min: 60, max: null });
  assert.equal(speedTarget(4, 'en'), null);
});

test('80% accuracy passes', () => {
  assert.equal(isPassed([true, true, true, true, false]), true);
  assert.equal(isPassed([true, true, true, false, false]), false);
});

test('tokens match the server tokenizer (danda and punctuation removed)', () => {
  assert.deepEqual(tokens(['राम घर जा रहा है।']), ['राम', 'घर', 'जा', 'रहा', 'है']);
  assert.deepEqual(tokens(['ఇది నా పుస్తకం.', 'The cat, is on the mat!']), ['ఇది', 'నా', 'పుస్తకం', 'The', 'cat', 'is', 'on', 'the', 'mat']);
});

test('pickItems prefers unseen items', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const used = new Set(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(pickItems(pool, 'letter', used).sort(), ['f', 'g', 'h', 'i', 'j']);
});
