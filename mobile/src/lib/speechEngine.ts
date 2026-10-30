// Adapter for the native on-device speech engine (sherpa-onnx, NeMo CTC models).
//
// This is the only file that talks to the native module. It is not wired yet: adding a native
// dependency needs the team's approval and a development build (it cannot run in Expo Go).
// Candidate packages, both wrapping sherpa-onnx:
//   - expo-sherpa-onnx (Expo module; pre-release 0.0.8; has createSTT + transcribeFile, NeMo CTC)
//   - react-native-sherpa-onnx (TurboModule; more mature; extra non-Expo peer dependencies)
// Until one is installed, isSpeechEngineAvailable() is false and the app works on teacher marks only.

export class SpeechEngineUnavailable extends Error {
  constructor() {
    super('On-device speech engine is not included in this build.');
  }
}

export function isSpeechEngineAvailable(): boolean {
  return false;
}

/**
 * Transcribe a 16 kHz mono WAV file with a NeMo CTC model folder containing
 * model.int8.onnx and tokens.txt. Returns plain text; never sends audio anywhere.
 */
export async function transcribeWav(_modelDir: string, _wavUri: string): Promise<string> {
  throw new SpeechEngineUnavailable();
}
