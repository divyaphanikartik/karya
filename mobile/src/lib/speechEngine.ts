// Adapter for the native on-device speech engine: expo-sherpa-onnx running NeMo CTC models.
// This is the only file that talks to the native module. It needs a development or preview build
// (EAS); in Expo Go the module is missing, isSpeechEngineAvailable() is false, and the app works on
// teacher marks alone.
import { requireOptionalNativeModule } from 'expo';
import { File } from 'expo-file-system';
import type { OfflineSTTEngine } from 'expo-sherpa-onnx';
import { SAMPLE_RATE, splitOnPauses, wavToSamples } from './wav';

export class SpeechEngineUnavailable extends Error {
  constructor() {
    super('On-device speech engine is not included in this build.');
  }
}

const available = requireOptionalNativeModule('ExpoSherpaOnnx') != null;

export function isSpeechEngineAvailable(): boolean {
  return available;
}

// The native side reads plain file paths, not file:// URIs.
const toPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/+$/, '');

// Loading a model takes a few seconds and 150-250 MB of RAM, so keep one recognizer: the one for
// the language being assessed. Switching language frees the previous model first.
let loaded: { dir: string; engine: Promise<OfflineSTTEngine> } | null = null;

async function recognizer(modelDir: string): Promise<OfflineSTTEngine> {
  if (loaded?.dir === modelDir) return loaded.engine;
  if (loaded) {
    const old = loaded.engine;
    loaded = null;
    await old.then((e) => e.destroy()).catch(() => {});
  }
  const { createSTT } = await import('expo-sherpa-onnx');
  const dir = toPath(modelDir);
  const engine = createSTT({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      nemoEncDecCtc: { model: `${dir}/model.int8.onnx` },
      tokens: `${dir}/tokens.txt`,
      modelType: 'nemo_ctc',
      numThreads: 2,
      provider: 'cpu',
    },
    decodingMethod: 'greedy_search',
  });
  loaded = { dir: modelDir, engine };
  // A failed load (e.g. a corrupt download) must not stay cached.
  engine.catch(() => {
    if (loaded?.engine === engine) loaded = null;
  });
  return engine;
}

/** Free the loaded model, e.g. after the model folder is deleted. */
export async function unloadSpeechEngine(): Promise<void> {
  if (!loaded) return;
  const old = loaded.engine;
  loaded = null;
  await old.then((e) => e.destroy()).catch(() => {});
}

/**
 * Transcribe a 16 kHz mono 16-bit WAV file with a NeMo CTC model folder containing
 * model.int8.onnx and tokens.txt. Returns plain text; never sends audio anywhere.
 */
export async function transcribeWav(modelDir: string, wavUri: string): Promise<string> {
  if (!available) throw new SpeechEngineUnavailable();
  const engine = await recognizer(modelDir);
  // The engine is handed samples, not the file: its own WAV reader rejects some recordings ("Failed to read
  // wave file"), and long readings are cut at pauses so the model's memory stays bounded.
  const samples = wavToSamples(await new File(wavUri).arrayBuffer());
  const texts: string[] = [];
  for (const piece of splitOnPauses(samples)) {
    texts.push((await engine.transcribeSamples(Array.from(piece), SAMPLE_RATE)).text.trim());
  }
  return texts.filter(Boolean).join(' ');
}
