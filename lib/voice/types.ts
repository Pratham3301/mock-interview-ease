import type { AppError } from "@/lib/gemini/errors";

export type VoiceSessionState =
  | "idle"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "assistant-thinking"
  | "assistant-speaking"
  | "preparing-voice"
  | "preparing-speech"
  | "generating-interview"
  | "generating-feedback"
  | "reconnecting"
  | "ending"
  | "finished"
  | "error";

export type VoiceMode = "live" | "fallback";

export interface VoicePreparationProgress {
  phase: "voice" | "speech-recognition";
  progress: number;
  label: string;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  final: boolean;
}

export interface InterviewRequirements {
  role: string;
  level: string;
  techstack: string;
  type: string;
  amount: number;
}

export interface VoiceSessionConfig {
  kind: "generate" | "interview";
  userName: string;
  userId: string;
  interviewId?: string;
  questions?: string[];
  initialTranscript?: TranscriptMessage[];
  operationId: string;
  apiKey?: string;
  forceFallback?: boolean;
}

export type TranscriptCallback = (message: TranscriptMessage) => void;
export type StateCallback = (state: VoiceSessionState) => void;
export type ErrorCallback = (error: AppError) => void;
export type ModeCallback = (mode: VoiceMode, notice?: string) => void;
export type ProgressCallback = (progress: VoicePreparationProgress) => void;
export type CompleteCallback = (reason: "interview" | "generation") => void;

export interface VoiceSession {
  start(config: VoiceSessionConfig): Promise<void>;
  stop(): Promise<void>;
  retry(): Promise<void>;
  useFallback(): Promise<void>;
  setApiKey(apiKey?: string): void;
  onTranscript(callback: TranscriptCallback): () => void;
  onStateChange(callback: StateCallback): () => void;
  onError(callback: ErrorCallback): () => void;
  onModeChange(callback: ModeCallback): () => void;
  onProgress(callback: ProgressCallback): () => void;
  onComplete(callback: CompleteCallback): () => void;
}
