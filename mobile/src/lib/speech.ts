// Offline speech: model downloads (from the Karya server, once, ideally on Wi-Fi), WAV recording,
// and on-device transcription. Audio stays on the phone and is deleted right after transcription.
import { useCallback } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import {
  forgetSpeechModel, installedSpeechModel, recordSpeechModel, type InstalledSpeechModel,
} from './db';
import type { Language } from './placement';
import { isSpeechEngineAvailable, transcribeWav, unloadSpeechEngine } from './speechEngine';
import { apiUrl } from './sync';

export type SpeechModelFile = { name: string; url: string; size: number; sha256: string };
export type SpeechModelInfo = {
  id: string; language: Language; engine: string; licence: string; source: string;
  size_bytes: number; files: SpeechModelFile[];
};

export const speechSupported = true;

const MODELS_ROOT = () => new Directory(Paths.document, 'speech_models');

export async function fetchSpeechModels(db: SQLiteDatabase): Promise<SpeechModelInfo[]> {
  const res = await fetch(`${await apiUrl(db)}/api/speech-models`);
  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
  return ((await res.json()) as { models: SpeechModelInfo[] }).models;
}

/** Download both model files; a size check catches truncated downloads on flaky networks. */
export async function downloadSpeechModel(db: SQLiteDatabase, model: SpeechModelInfo): Promise<void> {
  const root = MODELS_ROOT();
  if (!root.exists) root.create();
  const dir = new Directory(root, model.id);
  if (dir.exists) dir.delete();
  dir.create();
  try {
    for (const f of model.files) {
      const target = new File(dir, f.name);
      const file = await File.downloadFileAsync(f.url, target, { idempotent: true });
      if (file.size !== f.size) throw new Error(`${f.name}: expected ${f.size} bytes, got ${file.size}`);
    }
  } catch (e) {
    dir.delete();
    throw e;
  }
  await recordSpeechModel(db, { id: model.id, language: model.language, dir: dir.uri, size_bytes: model.size_bytes });
}

export async function deleteSpeechModel(db: SQLiteDatabase, model: InstalledSpeechModel): Promise<void> {
  await unloadSpeechEngine();
  const dir = new Directory(model.dir);
  if (dir.exists) dir.delete();
  await forgetSpeechModel(db, model.id);
}

export type SpeechResult = { transcript: string; modelId: string };

/**
 * Transcribe a recording if this language's model is installed and the engine is in the build.
 * Returns null when speech isn't available, so the check continues on teacher marks alone.
 * The WAV is always deleted afterwards.
 */
export async function transcribeAndDiscard(db: SQLiteDatabase, language: Language, wavUri: string): Promise<SpeechResult | null> {
  try {
    const model = await installedSpeechModel(db, language);
    if (!model || !isSpeechEngineAvailable()) return null;
    const transcript = await transcribeWav(model.dir, wavUri);
    return { transcript: transcript.trim(), modelId: model.id };
  } finally {
    const wav = new File(wavUri);
    if (wav.exists) wav.delete();
  }
}

/** 16 kHz mono 16-bit WAV straight from the microphone: the input format the speech models expect. */
export function useWavRecorder() {
  const { stream, isStreaming } = useAudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16' });

  const start = useCallback(async (): Promise<boolean> => {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) return false;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await stream.start();
    await stream.startFileRecordingAsync({ format: 'wav', directory: 'document' });
    return true;
  }, [stream]);

  const stop = useCallback(async (): Promise<{ uri: string; duration: number }> => {
    const result = await stream.stopFileRecordingAsync();
    stream.stop();
    await setAudioModeAsync({ allowsRecording: false });
    return { uri: result.uri, duration: result.duration };
  }, [stream]);

  return { start, stop, isRecording: isStreaming };
}
