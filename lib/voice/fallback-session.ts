import { microphoneError, type AppError } from "@/lib/gemini/errors";
import {
  createLocalSpeechRecognizer,
  createSpeechRecognizer,
  isSpeechRecognitionSupported,
  shouldFallbackToLocalSpeechRecognition,
  type SpeechRecognizerCallbacks,
  type SpeechRecognizer,
} from "@/lib/stt";
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
  private recognizer?: SpeechRecognizer;
  private readonly speaker = new KokoroSpeaker();
  private stopping = false;
  private processing = false;
  private switchingRecognizer = false;
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

    if (!isSpeechRecognitionSupported()) {
      throw this.unsupportedSpeechError();
    }

    this.emitMode(
      "fallback",
      "Live voice is unavailable, so compatibility voice mode is being used."
    );
    this.emitState("preparing-voice");
    try {
      await this.speaker.prepare((progress) =>
        this.emitProgress({
          phase: "voice",
          progress,
          label: "Downloading Kokoro voice",
        })
      );
    } catch (error) {
      await this.cleanup();
      throw this.voicePlaybackError(error);
    }

    this.recognizer = createSpeechRecognizer(this.recognizerCallbacks());

    this.emitState("connecting");
    try {
      await this.recognizer.requestPermission();
    } catch (error) {
      await this.cleanup();
      throw microphoneError(error);
    }

    if (this.recognizer.kind === "local") {
      this.emitState("preparing-speech");
      try {
        await this.prepareLocalRecognizer(this.recognizer);
      } catch (error) {
        await this.cleanup();
        if (this.stopping) return;
        throw this.speechRecognitionError(
          error instanceof Error ? error : new Error(String(error)),
          "local"
        );
      }
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

  private recognizerCallbacks(): SpeechRecognizerCallbacks {
    return {
      onResult: (transcript) => void this.handleUserTranscript(transcript),
      onSpeechActivity: (speaking) =>
        this.emitState(speaking ? "user-speaking" : "assistant-thinking"),
      onError: (error) => void this.handleSpeechRecognitionError(error),
    };
  }

  private prepareLocalRecognizer(recognizer: SpeechRecognizer) {
    return recognizer.prepare((progress) =>
      this.emitProgress({
        phase: "speech-recognition",
        progress,
        label: "Downloading local speech model",
      })
    );
  }

  private async handleSpeechRecognitionError(error: Error) {
    const recognizer = this.recognizer;
    if (
      !recognizer ||
      this.stopping ||
      this.switchingRecognizer ||
      !shouldFallbackToLocalSpeechRecognition(error, recognizer.kind)
    ) {
      if (!this.stopping) {
        this.emitError(this.speechRecognitionError(error, recognizer?.kind));
      }
      return;
    }

    this.switchingRecognizer = true;
    recognizer.abort();
    try {
      const localRecognizer = createLocalSpeechRecognizer(
        this.recognizerCallbacks()
      );
      this.recognizer = localRecognizer;
      this.emitMode(
        "fallback",
        "The browser speech service is unavailable, so local speech recognition is being used."
      );
      this.emitState("preparing-speech");
      await localRecognizer.requestPermission();
      await this.prepareLocalRecognizer(localRecognizer);
      if (!this.stopping && this.recognizer === localRecognizer) {
        this.startListening();
      }
    } catch (localError) {
      const failedRecognizer = this.recognizer;
      if (failedRecognizer?.kind === "local") {
        failedRecognizer.abort();
        if (this.recognizer === failedRecognizer) this.recognizer = undefined;
      }
      if (!this.stopping) {
        this.emitError(
          this.speechRecognitionError(
            localError instanceof Error
              ? localError
              : new Error(String(localError)),
            "local"
          )
        );
      }
    } finally {
      this.switchingRecognizer = false;
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
    this.emitState("assistant-thinking");
    try {
      await this.speaker.speak(content, {
        onPlaybackStart: () => this.emitState("assistant-speaking"),
      });
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
        "This browser can't run native or local speech recognition. Try a current browser with WebAssembly support or go back.",
      retryable: false,
      fallbackAvailable: false,
      byokAvailable: false,
    };
  }

  private speechRecognitionError(
    error: Error,
    recognizerKind = this.recognizer?.kind
  ): AppError {
    const normalized = error.message.toLowerCase();
    if (recognizerKind === "browser" && normalized.includes("network")) {
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
    if (recognizerKind === "local") {
      return {
        code: "browser-unsupported",
        title: "Local speech recognition couldn't start",
        message:
          "The local speech model couldn't run in this browser. Check WebAssembly support and try again.",
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
