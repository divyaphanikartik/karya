// Reading a recording's samples in JavaScript, so the speech engine is handed numbers and not a file. The
// engine's own WAV reader is strict and rejects recordings whose header is not the plain 44-byte kind
// ("Failed to read wave file"); this reader finds the chunks itself and tolerates a header whose length fields
// were not finalised.

export const SAMPLE_RATE = 16000;

/** 16-bit PCM WAV bytes -> mono float samples in [-1, 1] at 16 kHz. */
export function wavToSamples(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  const tag = (at: number) =>
    at + 4 <= view.byteLength ? String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3)) : '';
  let channels = 1;
  let rate = SAMPLE_RATE;
  let bits = 16;
  let dataStart = 44; // a plain header, if no chunks can be read
  let dataLength = Math.max(0, view.byteLength - 44);
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let at = 12;
    while (at + 8 <= view.byteLength) {
      const id = tag(at);
      const size = view.getUint32(at + 4, true);
      if (id === 'fmt ' && at + 24 <= view.byteLength) {
        channels = Math.max(1, view.getUint16(at + 10, true));
        rate = view.getUint32(at + 12, true) || SAMPLE_RATE;
        bits = view.getUint16(at + 22, true) || 16;
      } else if (id === 'data') {
        dataStart = at + 8;
        // A recording still being written (or stopped abruptly) can leave 0 or 0xFFFFFFFF here: use what is there.
        const available = view.byteLength - dataStart;
        dataLength = size === 0 || size > available ? available : size;
        break;
      }
      at += 8 + size + (size % 2); // chunks are padded to an even length
    }
  }
  if (bits !== 16) throw new Error(`Unsupported WAV: ${bits}-bit audio`);
  const frames = Math.floor(dataLength / (2 * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = view.getInt16(dataStart + i * 2 * channels, true) / 32768; // first channel
  if (rate === SAMPLE_RATE) return mono;
  const outLength = Math.floor((frames * SAMPLE_RATE) / rate);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) out[i] = mono[Math.min(frames - 1, Math.floor((i * rate) / SAMPLE_RATE))];
  return out;
}

/**
 * Cut samples into pieces of at most `chunkSeconds`, at the quietest 0.2 s near each cut (children pause
 * between words), because the model's memory grows steeply with the length of what it is given.
 */
export function splitOnPauses(samples: Float32Array, chunkSeconds = 10, searchSeconds = 2): Float32Array[] {
  const limit = Math.floor(chunkSeconds * SAMPLE_RATE);
  if (samples.length <= limit) return [samples];
  const window = Math.floor(0.2 * SAMPLE_RATE);
  const search = Math.floor(searchSeconds * SAMPLE_RATE);
  const hop = 160;
  const pieces: Float32Array[] = [];
  let start = 0;
  while (samples.length - start > limit) {
    const end = start + limit;
    const lo = Math.max(start + window, end - search);
    let best = lo;
    let bestEnergy = Infinity;
    for (let at = lo; at + window <= end; at += hop) {
      let energy = 0;
      for (let k = at; k < at + window; k += 4) energy += samples[k] * samples[k];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        best = at;
      }
    }
    const cut = best + Math.floor(window / 2);
    pieces.push(samples.subarray(start, cut));
    start = cut;
  }
  pieces.push(samples.subarray(start));
  return pieces;
}
