import type { AppError } from "@/lib/gemini/errors";
import { classifyGeminiError } from "@/lib/gemini/errors";
import { isSpeechRecognitionSupported } from "@/lib/stt";
import { BaseVoiceSession } from "./VoiceSession";
import { FallbackVoiceSession } from "./fallback-session";
import { GeminiLiveSession } from "./gemini-live";
import { toAppError } from "./http";
import { establishVoiceMode } from "./recovery";
import type {
  VoiceMode,
  VoiceSession,
  VoiceSessionConfig,
} from "./types";

function isAppError(error: unknown): error is AppError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      "message" in error &&
      "title" in error
  );
}

export class ManagedVoiceSession extends BaseVoiceSession {
  private active?: VoiceSession;
  private activeMode?: VoiceMode;
  private unbindActive: Array<() => void> = [];
  private switching = false;
  private startInFlight?: Promise<void>;
  private liveModelAttempt = 0;

  start(config: VoiceSessionConfig) {
    if (this.startInFlight) return this.startInFlight;
    this.config = { ...config };
    this.transcript = [...(config.initialTranscript ?? [])];
    this.startInFlight = this.startPreferred(config).finally(() => {
      this.startInFlight = undefined;
    });
    return this.startInFlight;
  }

  async stop() {
    await this.active?.stop();
    this.unbind();
    this.active = undefined;
    this.activeMode = undefined;
  }

  async retry() {
    try {
      if (this.active) {
        await this.active.retry();
        return;
      }
      if (this.config) await this.start(this.config);
    } catch (error) {
      this.emitSupportedError(
        isAppError(error) ? error : classifyGeminiError(error)
      );
    }
  }

  async useFallback() {
    if (this.switching || this.activeMode === "fallback" || !this.config) return;
    await this.switchToFallback(
      "Live voice is unavailable, so compatibility voice mode is being used."
    );
  }

  setApiKey(apiKey?: string) {
    if (this.config) this.config.apiKey = apiKey;
    this.active?.setApiKey(apiKey);
  }

  private async startPreferred(config: VoiceSessionConfig) {
    try {
      await establishVoiceMode({
        startLive: () => this.startLive(config),
        startFallback: () =>
          this.startFallback({
            ...config,
            initialTranscript: this.transcript,
            forceFallback: true,
          }),
        fallbackSupported: isSpeechRecognitionSupported(),
        forceFallback: config.forceFallback,
        onRetry: () => this.emitState("reconnecting"),
        pause: (milliseconds) =>
          new Promise<void>((resolve) =>
            window.setTimeout(resolve, milliseconds)
          ),
      });
    } catch (error) {
      this.emitSupportedError(
        isAppError(error) ? error : classifyGeminiError(error)
      );
    }
  }

  private async startLive(config: VoiceSessionConfig) {
    try {
      await this.replaceActive(
        new GeminiLiveSession(this.liveModelAttempt),
        "live"
      );
      await this.active!.start({
        ...config,
        initialTranscript: this.transcript,
      });
    } catch (error) {
      const appError = isAppError(error) ? error : toAppError(error);
      if (appError.code !== "model-unavailable" || this.liveModelAttempt > 0) {
        throw appError;
      }

      this.liveModelAttempt = 1;
      this.emitState("reconnecting");
      await this.replaceActive(new GeminiLiveSession(1), "live");
      await this.active!.start({
        ...config,
        initialTranscript: this.transcript,
      });
    }
  }

  private async startFallback(config: VoiceSessionConfig) {
    await this.replaceActive(new FallbackVoiceSession(), "fallback");
    await this.active!.start({
      ...config,
      initialTranscript: this.transcript,
      forceFallback: true,
    });
  }

  private async replaceActive(session: VoiceSession, mode: VoiceMode) {
    const previous = this.active;
    this.unbind();
    this.active = undefined;
    this.activeMode = undefined;
    if (previous) await previous.stop();
    this.active = session;
    this.activeMode = mode;
    this.bind(session, mode);
  }

  private bind(session: VoiceSession, mode: VoiceMode) {
    this.unbindActive = [
      session.onTranscript((message) => this.emitTranscript(message)),
      session.onStateChange((state) => this.emitState(state)),
      session.onModeChange((nextMode, notice) =>
        this.emitMode(nextMode, notice)
      ),
      session.onProgress((progress) => this.emitProgress(progress)),
      session.onComplete((reason) => this.emitComplete(reason)),
      session.onError((error) => void this.handleSessionError(error, mode)),
    ];
  }

  private async handleSessionError(error: AppError, mode: VoiceMode) {
    if (
      mode === "live" &&
      error.code === "model-unavailable" &&
      this.liveModelAttempt === 0 &&
      this.config &&
      !this.switching
    ) {
      this.switching = true;
      this.liveModelAttempt = 1;
      this.emitState("reconnecting");
      try {
        await this.startLive({
          ...this.config,
          initialTranscript: this.transcript,
        });
        return;
      } catch (olderModelError) {
        error = isAppError(olderModelError)
          ? olderModelError
          : toAppError(olderModelError);
      } finally {
        this.switching = false;
      }
    }

    if (
      mode === "live" &&
      this.state !== "generating-interview" &&
      error.fallbackAvailable &&
      isSpeechRecognitionSupported()
    ) {
      await this.switchToFallback(
        "Live voice was interrupted. Your completed transcript has been kept and compatibility voice mode is continuing."
      );
      return;
    }
    this.emitSupportedError(error);
  }

  private async switchToFallback(notice: string) {
    if (this.switching || !this.config) return;
    if (!isSpeechRecognitionSupported()) {
      this.emitError({
        code: "browser-unsupported",
        title: "Voice recognition isn't supported",
        message:
          "This browser can't run native or local speech recognition. Try a current browser with WebAssembly support or go back.",
        retryable: false,
        fallbackAvailable: false,
        byokAvailable: false,
      });
      return;
    }
    this.switching = true;
    try {
      await this.startFallback({
        ...this.config,
        initialTranscript: this.transcript,
        forceFallback: true,
      });
      this.emitMode("fallback", notice);
    } catch (error) {
      this.emitError(isAppError(error) ? error : classifyGeminiError(error));
    } finally {
      this.switching = false;
    }
  }

  private unbind() {
    this.unbindActive.forEach((unsubscribe) => unsubscribe());
    this.unbindActive = [];
  }

  private emitSupportedError(error: AppError) {
    this.emitError(
      !isSpeechRecognitionSupported() && error.fallbackAvailable
        ? { ...error, fallbackAvailable: false }
        : error
    );
  }
}

export function createVoiceSession(): VoiceSession {
  return new ManagedVoiceSession();
}

export type { AppError } from "@/lib/gemini/errors";
export type {
  TranscriptMessage,
  VoiceMode,
  VoiceSession,
  VoiceSessionConfig,
  VoiceSessionState,
  VoicePreparationProgress,
} from "./types";
