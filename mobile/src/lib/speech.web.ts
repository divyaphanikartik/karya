// Web build: on-device speech needs the native engine and phone file storage, so the browser
// version runs on teacher marks alone. Same exports as speech.ts so screens compile unchanged.
import type { SQLiteDatabase } from 'expo-sqlite';
import type { InstalledSpeechModel } from './db';
import type { Language } from './placement';

export type SpeechModelFile = { name: string; url: string; size: number; sha256: string };
export type SpeechModelInfo = {
  id: string; language: Language; engine: string; licence: string; source: string;
  size_bytes: number; files: SpeechModelFile[];
};
export type SpeechResult = { transcript: string; modelId: string };

export const speechSupported = false;

export async function fetchSpeechModels(_db: SQLiteDatabase): Promise<SpeechModelInfo[]> {
  return [];
}

export async function downloadSpeechModel(_db: SQLiteDatabase, _model: SpeechModelInfo): Promise<void> {
  throw new Error('Offline speech is available in the Android app only.');
}

export async function deleteSpeechModel(_db: SQLiteDatabase, _model: InstalledSpeechModel): Promise<void> {}

export async function transcribeAndDiscard(_db: SQLiteDatabase, _language: Language, _wavUri: string): Promise<SpeechResult | null> {
  return null;
}

export function useWavRecorder() {
  return {
    start: async () => false,
    stop: async (): Promise<{ uri: string; duration: number }> => ({ uri: '', duration: 0 }),
    isRecording: false,
  };
}
