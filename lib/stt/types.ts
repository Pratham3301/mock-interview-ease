export type RecognitionResultCallback = (transcript: string) => void;
export type RecognitionStateCallback = (speaking: boolean) => void;

export interface SpeechRecognizer {
  readonly kind: "browser" | "local";
  requestPermission(): Promise<void>;
  prepare(onProgress?: (progress: number) => void): Promise<void>;
  start(): void;
  stop(): void;
  abort(): void;
}
