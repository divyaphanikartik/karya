// Web build: no native speech engine. Same exports as speechEngine.ts.
export class SpeechEngineUnavailable extends Error {
  constructor() {
    super('On-device speech engine is not included in this build.');
  }
}

export function isSpeechEngineAvailable(): boolean {
  return false;
}

export async function unloadSpeechEngine(): Promise<void> {}

export async function transcribeWav(_modelDir: string, _wavUri: string): Promise<string> {
  throw new SpeechEngineUnavailable();
}
