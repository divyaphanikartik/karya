// Student recordings: record on the phone, transcribe on the Karya server (AI4Bharat IndicConformer for
// Telugu/Hindi, NVIDIA NeMo for English). Offline, the recording waits on the phone and is uploaded at the
// next sync. The server never keeps the audio; the phone deletes it once it has a transcript.
import { useCallback } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { File } from 'expo-file-system';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { AuthError, apiFetch } from './api';
import type { Language } from './placement';

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
  // React Native's FormData accepts a { uri, name, type } descriptor for file parts.
  form.append('audio', { uri, name: 'recording.wav', type: 'audio/wav' } as unknown as Blob);
  return apiFetch(db, '/api/transcribe', { method: 'POST', body: form }, 60000);
}

export function discardRecording(uri: string | null) {
  if (!uri) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}

export async function transcribeRecording(db: SQLiteDatabase, language: Language, uri: string): Promise<TranscribeOutcome> {
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
