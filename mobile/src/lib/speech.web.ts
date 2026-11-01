// Browser build: record with the browser's MediaRecorder (WebM/Opus) and send it straight to the Karya
// server, which transcribes it with the same models as the phone app. A browser cannot keep recordings
// across reloads, so without a connection the check continues on teacher marks alone.
import { useCallback, useRef, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { AuthError, apiFetch } from './api';
import type { Language } from './placement';

export const speechSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  && typeof MediaRecorder !== 'undefined';
export const canQueueRecordings = false;

export type SpeechResult = { transcript: string; modelId: string };
export type TranscribeOutcome =
  | { status: 'done'; result: SpeechResult }
  | { status: 'queued' }
  | { status: 'unavailable'; reason: 'no_model' | 'failed' | 'offline' };

/** The browser has no on-device speech engine. */
export const onDeviceSpeechInBuild = (): boolean => false;

export type SpeechModelFile = { name: string; url: string; size: number; sha256: string };
export type SpeechModelInfo = {
  id: string; language: Language; engine: string; licence: string; source: string;
  size_bytes: number; files: SpeechModelFile[];
};
export async function fetchSpeechModels(_db: SQLiteDatabase): Promise<SpeechModelInfo[]> {
  return [];
}
export async function downloadSpeechModel(_db: SQLiteDatabase, _model: SpeechModelInfo): Promise<void> {}
export async function deleteSpeechModel(_db: SQLiteDatabase, _model: { id: string }): Promise<void> {}
export const lastOnDeviceSpeechError = (): string | null => null;
export async function transcribeOnDevice(_db: SQLiteDatabase, _language: Language, _uri: string): Promise<SpeechResult | null> {
  return null;
}

export async function uploadRecording(db: SQLiteDatabase, language: Language, uri: string): Promise<Response> {
  const blob = await (await fetch(uri)).blob();
  const form = new FormData();
  form.append('language', language);
  form.append('audio', blob, blob.type.includes('ogg') ? 'recording.ogg' : 'recording.webm');
  return apiFetch(db, '/api/transcribe', { method: 'POST', body: form }, 60000);
}

/** The browser never keeps a recording to upload later, so there is nothing to find. */
export function recordingExists(_uri: string): boolean {
  return false;
}

export function discardRecording(uri: string | null) {
  if (uri) URL.revokeObjectURL(uri);
}

export async function transcribeRecording(db: SQLiteDatabase, language: Language, uri: string): Promise<TranscribeOutcome> {
  try {
    const res = await uploadRecording(db, language, uri);
    if (!res.ok) return { status: 'unavailable', reason: res.status === 503 ? 'no_model' : 'failed' };
    const body = (await res.json()) as { transcript: string; model: string };
    return { status: 'done', result: { transcript: body.transcript, modelId: body.model } };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return { status: 'unavailable', reason: 'offline' };
  } finally {
    discardRecording(uri);
  }
}

export function useWavRecorder() {
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const [isRecording, setIsRecording] = useState(false);

  const start = useCallback(async (): Promise<boolean> => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      return false; // permission denied or no microphone
    }
    chunks.current = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    rec.start();
    recorder.current = rec;
    startedAt.current = Date.now();
    setIsRecording(true);
    return true;
  }, []);

  const stop = useCallback(async (): Promise<{ uri: string; duration: number }> => {
    const rec = recorder.current;
    if (!rec) return { uri: '', duration: 0 };
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    rec.stream.getTracks().forEach((track) => track.stop()); // release the microphone
    recorder.current = null;
    setIsRecording(false);
    const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
    return { uri: URL.createObjectURL(blob), duration: (Date.now() - startedAt.current) / 1000 };
  }, []);

  return { start, stop, isRecording };
}
