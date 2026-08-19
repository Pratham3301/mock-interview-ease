import type {
  CompleteCallback,
  ErrorCallback,
  ModeCallback,
  ProgressCallback,
  StateCallback,
  TranscriptCallback,
  TranscriptMessage,
  VoiceMode,
  VoiceSession,
  VoiceSessionConfig,
  VoiceSessionState,
  VoicePreparationProgress,
} from "./types";
import type { AppError } from "@/lib/gemini/errors";

type Listener<T> = (value: T) => void;

export abstract class BaseVoiceSession implements VoiceSession {
  protected config?: VoiceSessionConfig;
  protected transcript: TranscriptMessage[] = [];
  protected state: VoiceSessionState = "idle";

  private transcriptListeners = new Set<TranscriptCallback>();
  private stateListeners = new Set<StateCallback>();
  private errorListeners = new Set<ErrorCallback>();
  private modeListeners = new Set<ModeCallback>();
  private progressListeners = new Set<ProgressCallback>();
  private completeListeners = new Set<CompleteCallback>();

  abstract start(config: VoiceSessionConfig): Promise<void>;
  abstract stop(): Promise<void>;
  abstract retry(): Promise<void>;
  abstract useFallback(): Promise<void>;
  abstract setApiKey(apiKey?: string): void;

  onTranscript(callback: TranscriptCallback) {
    return this.addListener(this.transcriptListeners, callback);
  }

  onStateChange(callback: StateCallback) {
    return this.addListener(this.stateListeners, callback);
  }

  onError(callback: ErrorCallback) {
    return this.addListener(this.errorListeners, callback);
  }

  onModeChange(callback: ModeCallback) {
    this.modeListeners.add(callback);
    return () => this.modeListeners.delete(callback);
  }

  onProgress(callback: ProgressCallback) {
    return this.addListener(this.progressListeners, callback);
  }

  onComplete(callback: CompleteCallback) {
    return this.addListener(this.completeListeners, callback);
  }

  protected emitTranscript(message: TranscriptMessage) {
    if (!message.final || !message.content.trim()) return;
    const normalized = { ...message, content: message.content.trim() };
    this.transcript.push(normalized);
    this.transcriptListeners.forEach((callback) => callback(normalized));
  }

  protected emitState(state: VoiceSessionState) {
    this.state = state;
    this.stateListeners.forEach((callback) => callback(state));
  }

  protected emitError(error: AppError) {
    this.emitState("error");
    this.errorListeners.forEach((callback) => callback(error));
  }

  protected emitMode(mode: VoiceMode, notice?: string) {
    this.modeListeners.forEach((callback) => callback(mode, notice));
  }

  protected emitProgress(progress: VoicePreparationProgress) {
    this.progressListeners.forEach((callback) => callback(progress));
  }

  protected emitComplete(reason: "interview" | "generation") {
    this.completeListeners.forEach((callback) => callback(reason));
  }

  private addListener<T>(listeners: Set<Listener<T>>, callback: Listener<T>) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }
}
