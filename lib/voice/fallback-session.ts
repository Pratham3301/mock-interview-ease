import { microphoneError, type AppError } from "@/lib/gemini/errors";
import { BrowserSpeechRecognizer } from "@/lib/stt/browser";
import { KokoroSpeaker } from "@/lib/tts/kokoro";
import { BaseVoiceSession } from "./VoiceSession";
import { postJson, toAppError } from "./http";
import { RetainedOperation } from "./operations";
import type {
  InterviewRequirements,
  TranscriptMessage,
  VoiceSessionConfig,
} from "./types";

interface CompatibilityResponse {
  success: true;
  response: string;
  requirements?: InterviewRequirements | null;
  completed?: boolean;
}

interface InterviewGenerationResponse {
  success: true;
  interviewId: string;
}

export class FallbackVoiceSession extends BaseVoiceSession {
  private recognizer?: BrowserSpeechRecognizer;
  private readonly speaker = new KokoroSpeaker();
  private stopping = false;
  private processing = false;
  private lastResponseRequest = false;
  private requirementsOperation = new RetainedOperation(
    (requirements: InterviewRequirements) => this.createInterview(requirements)
  );

  async start(config: VoiceSessionConfig) {
    if (this.state === "connecting" || this.state === "listening") return;
    this.config = { ...config };
    this.transcript = [...(config.initialTranscript ?? [])];
    this.stopping = false;
    this.emitState("connecting");

    if (!BrowserSpeechRecognizer.isSupported()) {
      throw this.unsupportedSpeechError();
    }

    this.emitMode(
      "fallback",
      "Live voice is unavailable, so compatibility voice mode is being used."
    );
    this.emitState("preparing-voice");
    try {
      await this.speaker.prepare();
    } catch (error) {
      await this.cleanup();
      throw this.voicePlaybackError(error);
    }

    this.recognizer = new BrowserSpeechRecognizer(
      (transcript) => void this.handleUserTranscript(transcript),
      (speaking) =>
        this.emitState(speaking ? "user-speaking" : "assistant-thinking"),
      (error) => this.emitError(this.speechRecognitionError(error))
    );

    try {
      await this.recognizer.requestPermission();
    } catch (error) {
      await this.cleanup();
      throw microphoneError(error);
    }

    try {
      const lastStableTurn = this.transcript.at(-1);
      if (lastStableTurn?.role === "user") {
        this.lastResponseRequest = true;
        await this.requestNextResponse();
        return;
      }
      if (lastStableTurn?.role === "assistant") {
        this.startListening();
        return;
      }

      const firstMessage =
        config.kind === "generate"
          ? "Let's set up your mock interview. What job role are you preparing for?"
          : `Hello ${config.userName}. Let's begin. ${config.questions?.[0] ?? "Please tell me about your experience."}`;
      await this.speak(firstMessage);
      this.startListening();
    } catch (error) {
      await this.cleanup();
      throw this.isAppError(error) ? error : this.voicePlaybackError(error);
    }
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.emitState("ending");
    await this.cleanup();
    this.stopping = false;
    this.emitState("finished");
  }

  async retry() {
    if (this.requirementsOperation.hasInput()) {
      await this.retryInterviewGeneration();
      return;
    }
    if (this.lastResponseRequest) {
      await this.requestNextResponse();
      return;
    }
    const config = this.config;
    if (!config) return;
    await this.start({ ...config, initialTranscript: this.transcript });
  }

  async useFallback() {
    // This session is already using compatibility mode.
  }

  setApiKey(apiKey?: string) {
    if (this.config) this.config.apiKey = apiKey;
  }

  private async handleUserTranscript(content: string) {
    if (this.processing || this.stopping) return;
    this.processing = true;
    this.recognizer?.stop();
    this.emitTranscript({
      role: "user",
      content,
      timestamp: Date.now(),
      final: true,
    });
    this.lastResponseRequest = true;

    try {
      await this.requestNextResponse();
    } finally {
      this.processing = false;
    }
  }

  private async requestNextResponse() {
    if (!this.config) return;
    this.emitState("assistant-thinking");

    try {
      const result = await postJson<CompatibilityResponse>(
        "/api/gemini/respond",
        {
          kind: this.config.kind,
          userName: this.config.userName,
          questions: this.config.questions,
          transcript: this.transcript,
        },
        this.config.apiKey
      );
      this.lastResponseRequest = false;

      if (result.requirements) {
        this.emitState("generating-interview");
        await this.requirementsOperation.run(result.requirements);
        await this.speak(
          "Your mock interview is ready. You can find it on your dashboard."
        );
        await this.complete("generation");
        return;
      }

      await this.speak(result.response);
      if (result.completed) {
        await this.complete("interview");
      } else {
        this.startListening();
      }
    } catch (error) {
      this.emitError(this.operationError(error));
    }
  }

  private async retryInterviewGeneration() {
    this.emitState("generating-interview");
    try {
      await this.requirementsOperation.retry();
      await this.speak(
        "Your mock interview is ready. You can find it on your dashboard."
      );
      await this.complete("generation");
    } catch (error) {
      this.emitError(this.operationError(error, true));
    }
  }

  private createInterview(requirements: InterviewRequirements) {
    return postJson<InterviewGenerationResponse>(
      "/api/interviews/generate",
      { ...requirements, operationId: this.config!.operationId },
      this.config?.apiKey
    );
  }

  private async speak(content: string) {
    const message: TranscriptMessage = {
      role: "assistant",
      content,
      timestamp: Date.now(),
      final: true,
    };
    this.emitState("assistant-speaking");
    try {
      await this.speaker.speak(content);
      this.emitTranscript(message);
    } catch (error) {
      throw this.voicePlaybackError(error);
    }
  }

  private startListening() {
    if (this.stopping) return;
    this.emitState("listening");
    this.recognizer?.start();
  }

  private async complete(reason: "interview" | "generation") {
    await this.stop();
    this.emitComplete(reason);
  }

  private async cleanup() {
    this.recognizer?.abort();
    this.recognizer = undefined;
    await this.speaker.close();
  }

  private unsupportedSpeechError(): AppError {
    return {
      code: "browser-unsupported",
      title: "Voice recognition isn't supported",
      message:
        "Compatibility voice mode requires browser speech recognition. Try a supported Chromium browser or go back.",
      retryable: false,
      fallbackAvailable: false,
      byokAvailable: false,
    };
  }

  private speechRecognitionError(error: Error): AppError {
    const normalized = error.message.toLowerCase();
    if (normalized.includes("network")) {
      return {
        code: "network",
        title: "Speech recognition is unavailable",
        message:
          "The browser speech service couldn't connect. Check your connection and try again.",
        retryable: true,
        fallbackAvailable: false,
        byokAvailable: false,
        technicalMessage: error.message,
      };
    }
    return {
      code: "browser-unsupported",
      title: "Speech recognition stopped",
      message:
        "The browser speech recognizer couldn't continue. Check microphone access and try again.",
      retryable: true,
      fallbackAvailable: false,
      byokAvailable: false,
      technicalMessage: error.message,
    };
  }

  private voicePlaybackError(error: unknown): AppError {
    return {
      code: "voice-playback",
      title: "Voice playback couldn't be prepared",
      message: "The fallback speech engine couldn't start in this browser.",
      retryable: true,
      fallbackAvailable: false,
      byokAvailable: false,
      technicalMessage: error instanceof Error ? error.message : String(error),
    };
  }

  private operationError(error: unknown, generation = false): AppError {
    if (this.isAppError(error)) return error;
    const appError = toAppError(error);
    if (generation || this.requirementsOperation.hasInput()) {
      return {
        ...appError,
        code: appError.code === "unknown" ? "generation" : appError.code,
        title: "Interview couldn't be created",
        message:
          appError.code === "quota"
            ? appError.message
            : "We couldn't generate your interview questions. Your interview preferences have not been lost.",
        retryable: appError.code !== "quota",
      };
    }
    return appError;
  }

  private isAppError(error: unknown): error is AppError {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        "message" in error
    );
  }
}
