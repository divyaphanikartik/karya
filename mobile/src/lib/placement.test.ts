/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedLevel, isPassed, nextStep, pickItems, tokens } from './placement.ts';

test('grade 2 starts at sentence, grade 3 at paragraph', () => {
  assert.deepEqual(nextStep(2, []), { done: false, level: 'sentence' });
  assert.deepEqual(nextStep(3, []), { done: false, level: 'paragraph' });
});

test('pass moves up; failing the level above places at the passed level', () => {
  assert.deepEqual(nextStep(2, [{ level: 'sentence', passed: true }]), { done: false, level: 'paragraph' });
  assert.deepEqual(nextStep(2, [{ level: 'sentence', passed: true }, { level: 'paragraph', passed: false }]), { done: true, placed: 3 });
});

test('passing paragraph places at the top level', () => {
  assert.deepEqual(nextStep(3, [{ level: 'paragraph', passed: true }]), { done: true, placed: 4 });
});

test('fail moves down until a pass', () => {
  const a = [{ level: 'sentence', passed: false }] as const;
  assert.deepEqual(nextStep(2, [...a]), { done: false, level: 'word' });
  assert.deepEqual(nextStep(2, [...a, { level: 'word', passed: true }]), { done: true, placed: 2 });
});

test('failing letters places the child as beginner', () => {
  const all = [
    { level: 'sentence', passed: false }, { level: 'word', passed: false }, { level: 'letter', passed: false },
  ] as const;
  assert.deepEqual(nextStep(2, [...all]), { done: true, placed: 0 });
});

test('expected level and needs-help threshold by grade', () => {
  assert.equal(expectedLevel(1), 2);
  assert.equal(expectedLevel(2), 3);
  assert.equal(expectedLevel(4), 4);
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
