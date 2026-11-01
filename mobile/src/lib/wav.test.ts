/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_RATE, splitOnPauses, wavToSamples } from './wav.ts';

function wav(samples: number[], opts: { dataSize?: number; extraChunk?: boolean; rate?: number; channels?: number } = {}): ArrayBuffer {
  const channels = opts.channels ?? 1;
  const rate = opts.rate ?? SAMPLE_RATE;
  const extra = opts.extraChunk ? 12 : 0;
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + extra + dataBytes);
  const v = new DataView(buf);
  const put = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, 'RIFF'); v.setUint32(4, 36 + extra + dataBytes, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  let at = 36;
  if (opts.extraChunk) { put(at, 'LIST'); v.setUint32(at + 4, 4, true); put(at + 8, 'INFO'); at += 12; }
  put(at, 'data'); v.setUint32(at + 4, opts.dataSize ?? dataBytes, true);
  samples.forEach((s, i) => v.setInt16(at + 8 + i * 2, s, true));
  return buf;
}

test('plain 16-bit mono WAV becomes floats in [-1, 1]', () => {
  const out = wavToSamples(wav([0, 16384, -32768, 32767]));
  assert.deepEqual([...out].map((x) => Math.round(x * 1000) / 1000), [0, 0.5, -1, 1]);
});

test('an unfinished header (data size 0 or 0xFFFFFFFF) uses all the audio that is there', () => {
  assert.equal(wavToSamples(wav([1, 2, 3], { dataSize: 0 })).length, 3);
  assert.equal(wavToSamples(wav([1, 2, 3], { dataSize: 0xffffffff })).length, 3);
});

test('extra chunks before the audio are skipped', () => {
  assert.equal(wavToSamples(wav([100, 200], { extraChunk: true })).length, 2);
});

test('stereo keeps the first channel and a different rate is resampled to 16 kHz', () => {
  assert.deepEqual([...wavToSamples(wav([16384, 0, 16384, 0], { channels: 2 }))], [0.5, 0.5]);
  assert.equal(wavToSamples(wav(new Array(8000).fill(1000), { rate: 8000 })).length, 16000);
});

test('long audio is cut into bounded pieces, at the quiet moment near each cut', () => {
  const rate = SAMPLE_RATE;
  const samples = new Float32Array(rate * 25).fill(0.5);
  samples.fill(0, rate * 9 + 4000, rate * 9 + 4000 + 4800); // a pause just before the 10 s mark
  const pieces = splitOnPauses(samples, 10, 2);
  assert.ok(pieces.length >= 3 && pieces.every((p) => p.length <= 10 * rate));
  assert.equal(pieces.reduce((n, p) => n + p.length, 0), samples.length); // nothing lost
  assert.ok(pieces[0].length < 10 * rate && pieces[0].length > 9 * rate); // cut moved back to the pause
  assert.deepEqual(splitOnPauses(new Float32Array(100)).length, 1);
});
