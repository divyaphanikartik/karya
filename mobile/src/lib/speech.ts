// Student recordings: record on the phone and turn them into a transcript (AI4Bharat IndicConformer for
// Telugu/Hindi, NVIDIA NeMo for English). If this language's model is installed and the build has the speech
// engine, the phone transcribes on the device, with no internet, and deletes the audio. Otherwise (Expo Go,
// no model yet) the recording goes to the Karya server; with no connection it waits on the phone and is
// uploaded at the next sync. The server never keeps the audio.
import { useCallback } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { AuthError, apiFetch, apiUrl } from './api';
import {
  forgetSpeechModel, installedSpeechModel, recordSpeechModel, type InstalledSpeechModel,
} from './db';
import type { Language } from './placement';
import { isSpeechEngineAvailable, transcribeWav, unloadSpeechEngine } from './speechEngine';

/** True in a build that has the native speech engine (a development build or the APK; not Expo Go). */
export const onDeviceSpeechInBuild = (): boolean => isSpeechEngineAvailable();

export type SpeechModelFile = { name: string; url: string; size: number; sha256: string };
export type SpeechModelInfo = {
  id: string; language: Language; engine: string; licence: string; source: string;
  size_bytes: number; files: SpeechModelFile[];
};

const MODELS_ROOT = () => new Directory(Paths.document, 'speech_models');

export async function fetchSpeechModels(db: SQLiteDatabase): Promise<SpeechModelInfo[]> {
  const res = await fetch(`${await apiUrl(db)}/api/speech-models`);
  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
  return ((await res.json()) as { models: SpeechModelInfo[] }).models;
}

/** Download both model files from the Karya server; a size check catches truncated downloads on flaky networks. */
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

/**
 * Transcribe on the phone if this language's model is installed and the build has the engine.
 * Null when that is not possible (the caller then uses the server). The audio file is left alone here.
 */
let lastDeviceError: string | null = null;
/** Why the last on-device run failed (null if it did not, or was not tried); shown to the teacher next to the recording. */
export const lastOnDeviceSpeechError = (): string | null => lastDeviceError;

export async function transcribeOnDevice(db: SQLiteDatabase, language: Language, uri: string): Promise<SpeechResult | null> {
  lastDeviceError = null;
  if (!isSpeechEngineAvailable()) return null;
  try {
    const model = await installedSpeechModel(db, language);
    if (!model) return null;
    const transcript = await transcribeWav(model.dir, uri);
    return { transcript: transcript.trim(), modelId: model.id };
  } catch (e) {
    lastDeviceError = (e instanceof Error ? e.message : String(e)).slice(0, 160);
    console.warn('On-device speech failed:', lastDeviceError);
    return null; // a failed local run falls back to the server
  }
}

export const speechSupported = true;
/** The phone can keep a recording and transcribe it later (the browser cannot). */
export const canQueueRecordings = true;

export type SpeechResult = { transcript: string; modelId: string };
export type TranscribeOutcome =
  | { status: 'done'; result: SpeechResult }
  | { status: 'queued' } // offline: kept on the phone, uploaded at the next sync
  | { status: 'unavailable'; reason: 'no_model' | 'failed' | 'offline' };

/** Upload one recording; throws on network errors so the caller can queue it. */
export async function uploadRecording(db: SQLiteDatabase, language: Language, uri: string): Promise<Response> {
  const form = new FormData();
  form.append('language', language);
  // Expo's fetch (the app's fetch) cannot send React Native's { uri, name, type } descriptor; it sends a
  // File from expo-file-system as the part. The path needs a scheme (file://).
  const fileUri = /^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `file://${uri}`;
  form.append('audio', new File(fileUri) as unknown as Blob, 'recording.wav');
  return apiFetch(db, '/api/transcribe', { method: 'POST', body: form }, 60000);
}

/** False when the saved recording is gone (storage cleared, app reinstalled). */
export function recordingExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export function discardRecording(uri: string | null) {
  if (!uri) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}

export async function transcribeRecording(db: SQLiteDatabase, language: Language, uri: string): Promise<TranscribeOutcome> {
  // On the device first: works with no internet, and the audio never leaves the phone.
  const local = await transcribeOnDevice(db, language, uri);
  if (local) {
    discardRecording(uri);
    return { status: 'done', result: local };
  }
  let res: Response;
  try {
    res = await uploadRecording(db, language, uri);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return { status: 'queued' }; // no connection: keep the recording for the next sync
  }
  if (res.ok) {
    const body = (await res.json()) as { transcript: string; model: string };
    discardRecording(uri);
    return { status: 'done', result: { transcript: body.transcript, modelId: body.model } };
  }
  if (res.status === 429 || (res.status >= 500 && res.status !== 503)) return { status: 'queued' }; // retry at sync
  discardRecording(uri);
  return { status: 'unavailable', reason: res.status === 503 ? 'no_model' : 'failed' };
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
