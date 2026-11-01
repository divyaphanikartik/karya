/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITEMS_PER_LEVEL, LADDERS, canSayMeaning, displayTokens, expectedLevel, isPassed, itemsReadCorrectly, meaningLevel, nextGoal,
  itemsToRepeat, nextStep, pickItems, placedStep, plannedRound, practiceTarget, speedTarget, tokens, wordsPerMinute,
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

test('state language: ASER ladder, every grade starts at the paragraph', () => {
  assert.deepEqual(LADDERS.hi, ['letter', 'word', 'paragraph', 'story']);
  for (const grade of [1, 2, 3]) {
    assert.deepEqual(nextStep(grade, 'hi', []), { done: false, level: 'paragraph' });
    assert.deepEqual(nextStep(grade, 'te', []), { done: false, level: 'paragraph' });
  }
});

test('state language follows the ASER flow from the paragraph', () => {
  // Paragraph read: try the story; story read = story level, else paragraph level.
  assert.deepEqual(nextStep(3, 'hi', [{ level: 'paragraph', passed: true }]), { done: false, level: 'story' });
  assert.deepEqual(nextStep(3, 'hi', [{ level: 'paragraph', passed: true }, { level: 'story', passed: false }]), { done: true, placed: 3 });
  // Paragraph not read: words; words read = word level.
  assert.deepEqual(nextStep(3, 'te', [{ level: 'paragraph', passed: false }]), { done: false, level: 'word' });
  assert.deepEqual(nextStep(3, 'te', [{ level: 'paragraph', passed: false }, { level: 'word', passed: true }]), { done: true, placed: 2 });
  // Words not read: letters; letters read = letter level, else beginner.
  const down = [{ level: 'paragraph', passed: false }, { level: 'word', passed: false }] as const;
  assert.deepEqual(nextStep(1, 'hi', [...down]), { done: false, level: 'letter' });
  assert.deepEqual(nextStep(1, 'hi', [...down, { level: 'letter', passed: true }]), { done: true, placed: 1 });
  assert.deepEqual(nextStep(1, 'hi', [...down, { level: 'letter', passed: false }]), { done: true, placed: 0 });
});

test('paragraph and story: at most 3 mistakes and read fluently (ASER)', () => {
  const marks = (wrong: number) => Array.from({ length: 20 }, (_, i) => i >= wrong);
  assert.equal(isPassed('paragraph', ['…'], marks(3), true), true);
  assert.equal(isPassed('paragraph', ['…'], marks(4), true), false); // 80% correct, but 4 mistakes
  assert.equal(isPassed('story', ['…'], marks(0), false), false); // no mistakes, but word by word
});

test('English: ASER ladder, every grade starts at capital letters and climbs', () => {
  assert.deepEqual(LADDERS.en, ['capital', 'letter', 'word', 'sentence']);
  for (const grade of [1, 2, 3]) assert.deepEqual(nextStep(grade, 'en', []), { done: false, level: 'capital' });
  // Failing capitals: beginner.
  assert.deepEqual(nextStep(3, 'en', [{ level: 'capital', passed: false }]), { done: true, placed: 0 });
  // Capitals read: small letters next; not read = capital letter level.
  assert.deepEqual(nextStep(3, 'en', [{ level: 'capital', passed: true }]), { done: false, level: 'letter' });
  assert.deepEqual(nextStep(3, 'en', [{ level: 'capital', passed: true }, { level: 'letter', passed: false }]), { done: true, placed: 1 });
  // Every step read: sentence level, the top of the English ladder.
  const all = (['capital', 'letter', 'word', 'sentence'] as const).map((level) => ({ level, passed: true }));
  assert.deepEqual(nextStep(5, 'en', all), { done: true, placed: 4 });
});

test('passing the story places at the top of the state-language ladder', () => {
  const climb = [{ level: 'paragraph', passed: true }, { level: 'story', passed: true }] as const;
  assert.deepEqual(nextStep(5, 'te', [...climb]), { done: true, placed: 4 });
});

test('expected levels: Std 1 text by Grade 1, Std 2 text from Grade 2; next goal is one step up', () => {
  assert.equal(expectedLevel(1, 'hi'), 3); // paragraph (Std 1 text)
  assert.equal(expectedLevel(2, 'te'), 4); // story (Std 2 text)
  assert.equal(expectedLevel(3, 'hi'), 4); // story
  assert.equal(expectedLevel(5, 'hi'), 4); // an older Grade 4-5 record counts as Grade 3
  assert.equal(expectedLevel(3, 'en'), 3); // words
  assert.equal(nextGoal(0, 'en'), 'capital');
  assert.equal(nextGoal(2, 'hi'), 'paragraph');
  assert.equal(nextGoal(4, 'hi'), null);
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

test('4 of 5 words (80%) passes', () => {
  const words = ['cat', 'sun', 'pen', 'bus', 'hen'];
  assert.equal(isPassed('word', words, [true, true, true, true, false]), true);
  assert.equal(isPassed('word', words, [true, true, true, false, false]), false);
});

test('English sentences: 4 shown, at least 2 read with no mistakes (ASER)', () => {
  assert.equal(ITEMS_PER_LEVEL.sentence, 4);
  const s = ['The sun is hot.', 'I see a cat.', 'My cup is red.', 'I can run fast.'];
  // Each sentence has 4 words, so marks are 4 + 4 + 4 + 4.
  const twoClean = [true, true, true, true, /**/ true, true, true, true, /**/ false, true, true, true, /**/ true, false, true, true];
  assert.deepEqual(itemsReadCorrectly(s, twoClean), ['The sun is hot.', 'I see a cat.']);
  assert.equal(isPassed('sentence', s, twoClean), true);
  // 13 of 16 words right (81%), but one slip in each of three sentences: not at sentence level.
  const oneClean = [true, true, true, true, /**/ true, true, false, true, /**/ false, true, true, true, /**/ true, false, true, true];
  assert.deepEqual(itemsReadCorrectly(s, oneClean), ['The sun is hot.']);
  assert.equal(isPassed('sentence', s, oneClean), false);
});

test('meaning check: English word or sentence level only, ASER thresholds', () => {
  assert.equal(meaningLevel(3, 'en'), 'word');
  assert.equal(meaningLevel(4, 'en'), 'sentence');
  assert.equal(meaningLevel(2, 'en'), null); // small letters: no meaning check
  assert.equal(meaningLevel(3, 'hi'), null); // state language: reading only
  assert.equal(canSayMeaning('word', [true, true, true, true, false]), true);
  assert.equal(canSayMeaning('word', [true, true, true, false]), false);
  assert.equal(canSayMeaning('sentence', [true, true]), true);
  assert.equal(canSayMeaning('sentence', [true, false, false]), false);
});

test('tokens match the server tokenizer (danda and punctuation removed)', () => {
  assert.deepEqual(tokens(['राम घर जा रहा है।']), ['राम', 'घर', 'जा', 'रहा', 'है']);
  assert.deepEqual(tokens(['ఇది నా పుస్తకం.', 'The cat, is on the mat!']), ['ఇది', 'నా', 'పుస్తకం', 'The', 'cat', 'is', 'on', 'the', 'mat']);
});

test('pickItems prefers unseen items', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const used = new Set(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(pickItems(pool, 5, used).sort(), ['f', 'g', 'h', 'i', 'j']);
});

test('practice targets the next step and moves on once it is passed', () => {
  assert.equal(practiceTarget(2, 'en', new Set()), 'word'); // reads small letters: practise words
  assert.equal(practiceTarget(2, 'en', new Set(['word'] as const)), 'sentence');
  assert.equal(practiceTarget(0, 'hi', new Set()), 'letter'); // beginner
  assert.equal(practiceTarget(3, 'te', new Set(['story'] as const)), null); // whole ladder done
  assert.equal(practiceTarget(4, 'hi', new Set()), null); // already at the top
});

test('curly quotes split like straight quotes, so marks still line up', () => {
  const text = '“Come,” he said. ‘Yes!’';
  assert.deepEqual(tokens([text]), ['Come', 'he', 'said', 'Yes']);
  assert.deepEqual(displayTokens(text), ['“Come,”', 'he', 'said.', '‘Yes!’']);
});

test('missed items to practise later: whole items with any slip', () => {
  const words = ['mug', 'bed', 'pot', 'dog', 'van'];
  assert.deepEqual(itemsToRepeat(words, [false, false, false, true, true]), ['mug', 'bed', 'pot']);
  const sentences = ['Sit on the mat.', 'I can hop.'];
  assert.deepEqual(itemsToRepeat(sentences, [true, true, true, true, true, false, true]), ['I can hop.']);
});

test('a planned round starts with the planned items and fills up from the pool', () => {
  const round = plannedRound(['mug', 'bed', 'pot'], ['dog', 'mug', 'van', 'fan', 'jug'], 5);
  assert.deepEqual(round.slice(0, 3), ['mug', 'bed', 'pot']);
  assert.equal(round.length, 5);
  assert.equal(new Set(round).size, 5); // 'mug' is not repeated from the pool
  assert.deepEqual(plannedRound(['A long story.'], ['Another story.'], 1), ['A long story.']);
});
