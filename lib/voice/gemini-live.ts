import {
  ActivityHandling,
  GoogleGenAI,
  Modality,
  Type,
  VoiceActivityType,
  type FunctionCall,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Session,
} from "@google/genai";

import { classifyGeminiError, microphoneError } from "@/lib/gemini/errors";
import {
  INTERVIEW_REQUIREMENTS_TOOL,
  formatConversationHistory,
  getVoiceSystemInstruction,
} from "@/lib/gemini/prompts";
import { BaseVoiceSession } from "./VoiceSession";
import { PcmAudioPlayer, PcmMicrophone } from "./audio";
import { postJson, toAppError } from "./http";
import { RetainedOperation } from "./operations";
import {
  geminiClientSilenceDurationMs,
  geminiHybridVadEnabled,
  geminiVadConfig,
} from "./vad";
import type {
  InterviewRequirements,
  VoiceSessionConfig,
} from "./types";

const COMPLETE_INTERVIEW_TOOL = "completeInterview";

const requirementsTool: FunctionDeclaration = {
  name: INTERVIEW_REQUIREMENTS_TOOL,
  description:
    "Submit the confirmed mock interview preferences. Call exactly once after every field is collected and confirmed.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      role: { type: Type.STRING, description: "Target job role" },
      level: { type: Type.STRING, description: "Experience level" },
      techstack: {
        type: Type.STRING,
        description: "Comma-separated technology stack",
      },
      type: {
        type: Type.STRING,
        description: "Technical, behavioral, or mixed interview focus",
      },
      amount: {
        type: Type.INTEGER,
        description: "Number of questions from 1 to 20",
      },
    },
    required: ["role", "level", "techstack", "type", "amount"],
  },
};

const completeInterviewTool: FunctionDeclaration = {
  name: COMPLETE_INTERVIEW_TOOL,
  description:
    "Signal that all supplied primary interview questions have been completed.",
};

interface LiveTokenResponse {
  success: true;
  token: string;
  model: string;
  modelAttempt: number;
  legacyModel: boolean;
  apiVersion: string;
}

interface InterviewGenerationResponse {
  success: true;
  interviewId: string;
}

function parseRequirements(args?: Record<string, unknown>): InterviewRequirements {
  const amount = Number(args?.amount);
  const requirements = {
    role: String(args?.role ?? "").trim(),
    level: String(args?.level ?? "").trim(),
    techstack: String(args?.techstack ?? "").trim(),
    type: String(args?.type ?? "").trim(),
    amount,
  };

  if (
    !requirements.role ||
    !requirements.level ||
    !requirements.techstack ||
    !requirements.type ||
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 20
  ) {
    throw new Error("The collected interview preferences are incomplete.");
  }
  return requirements;
}

export class GeminiLiveSession extends BaseVoiceSession {
  private liveSession?: Session;
  private microphone?: PcmMicrophone;
  private readonly player = new PcmAudioPlayer((speaking) => {
    if (speaking) this.emitState("assistant-speaking");
    else if (!this.stopping && !this.completionPending) this.emitState("listening");
  });
  private stopping = false;
  private runtimeFailed = false;
  private completionPending = false;
  private inputTranscript = "";
  private outputTranscript = "";
  private handledToolCalls = new Set<string>();
  private transcriptWaiters = new Set<() => void>();
  private requirementsOperation = new RetainedOperation(
    (requirements: InterviewRequirements) => this.createInterview(requirements)
  );

  constructor(private readonly modelAttempt = 0) {
    super();
  }

  async start(config: VoiceSessionConfig) {
    if (this.liveSession || this.state === "connecting") return;
    this.config = { ...config };
    this.transcript = [...(config.initialTranscript ?? [])];
    this.stopping = false;
    this.runtimeFailed = false;
    this.completionPending = false;
    this.emitState("connecting");

    try {
      await this.player.prepare();
      this.microphone = new PcmMicrophone(
        (data, sampleRate) => {
          this.liveSession?.sendRealtimeInput({
            audio: { data, mimeType: `audio/pcm;rate=${sampleRate}` },
          });
        },
        (speaking) => {
          if (speaking) {
            this.player.interrupt();
            this.emitState("user-speaking");
          } else if (!this.stopping) {
            if (geminiHybridVadEnabled) {
              this.liveSession?.sendRealtimeInput({ audioStreamEnd: true });
            }
            this.emitState("assistant-thinking");
          }
        },
        geminiClientSilenceDurationMs
      );
      try {
        await this.microphone.start();
      } catch (error) {
        throw microphoneError(error);
      }

      const token = await postJson<LiveTokenResponse>(
        "/api/gemini/live-token",
        { modelAttempt: this.modelAttempt },
        config.apiKey
      );
      const client = new GoogleGenAI({
        apiKey: token.token,
        httpOptions: { apiVersion: token.apiVersion },
      });
      const previousContext = formatConversationHistory(
        config.initialTranscript ?? []
      );
      const systemInstruction = `${getVoiceSystemInstruction(config)}\n\nPrevious stable conversation turns:\n${previousContext}`;

      this.liveSession = await client.live.connect({
        model: token.model,
        callbacks: {
          onopen: () => {
            this.emitMode(
              "live",
              token.legacyModel
                ? "Gemini's newest Live voice is unavailable, so the older Gemini 2.5 Live voice model is being used."
                : undefined
            );
            this.emitState("listening");
          },
          onmessage: (message) => this.handleMessage(message),
          onerror: (event) => {
            void this.handleRuntimeFailure(
              event.error ?? new Error(event.message || "Live socket error")
            );
          },
          onclose: (event) => {
            if (!this.stopping && !this.runtimeFailed) {
              void this.handleRuntimeFailure(
                new Error(event.reason || "Live socket connection closed")
              );
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
            ...geminiVadConfig,
          },
          systemInstruction,
          tools: [
            {
              functionDeclarations:
                config.kind === "generate"
                  ? [requirementsTool]
                  : [completeInterviewTool],
            },
          ],
        },
      });

      this.liveSession.sendRealtimeInput({
        text:
          config.kind === "generate"
            ? "Begin by greeting the user briefly and asking for the first missing interview preference."
            : "Begin with a brief greeting and then ask the first supplied interview question.",
      });
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop() {
    if (this.stopping) return;
    this.emitState("ending");
    this.stopping = true;
    try {
      this.liveSession?.sendRealtimeInput({ audioStreamEnd: true });
    } catch {
      // The socket may already be closed.
    }
    await this.waitForStableTranscripts();
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.liveSession?.close();
    await this.cleanup();
    this.emitState("finished");
  }

  async retry() {
    if (this.requirementsOperation.hasInput()) {
      this.emitState("generating-interview");
      try {
        await this.requirementsOperation.retry();
        this.completionPending = true;
        this.liveSession?.sendRealtimeInput({
          text: "The saved interview preferences have now been submitted successfully. Briefly tell the user their interview is ready.",
        });
      } catch (error) {
        this.emitError(toAppError(error));
      }
      return;
    }

    const config = this.config;
    if (!config) return;
    await this.cleanup();
    await this.start({ ...config, initialTranscript: this.transcript });
  }

  async useFallback() {
    throw new Error("Fallback selection is handled by the session coordinator.");
  }

  setApiKey(apiKey?: string) {
    if (this.config) this.config.apiKey = apiKey;
  }

  private handleMessage(message: LiveServerMessage) {
    const content = message.serverContent;

    if (content?.interrupted) {
      this.player.interrupt();
      this.outputTranscript = "";
    }

    if (message.voiceActivity?.voiceActivityType === VoiceActivityType.ACTIVITY_START) {
      this.player.interrupt();
      this.emitState("user-speaking");
    } else if (
      message.voiceActivity?.voiceActivityType === VoiceActivityType.ACTIVITY_END
    ) {
      this.emitState("assistant-thinking");
    }

    if (content?.inputTranscription?.text) {
      this.inputTranscript += content.inputTranscription.text;
    }
    if (content?.inputTranscription?.finished) this.flushInputTranscript();

    if (content?.outputTranscription?.text) {
      this.outputTranscript += content.outputTranscription.text;
    }
    if (content?.outputTranscription?.finished) this.flushOutputTranscript();

    if (message.data) void this.player.play(message.data, 24_000);
    if (message.toolCall?.functionCalls) {
      void this.handleToolCalls(message.toolCall.functionCalls);
    }

    if (content?.turnComplete) {
      this.flushTranscripts();
      if (this.completionPending) void this.finishFromModel();
      else if (!this.stopping) this.emitState("listening");
    }
  }

  private async handleToolCalls(functionCalls: FunctionCall[]) {
    for (const call of functionCalls) {
      const callKey = call.id ?? `${call.name}:${JSON.stringify(call.args)}`;
      if (this.handledToolCalls.has(callKey)) continue;
      this.handledToolCalls.add(callKey);

      if (call.name === COMPLETE_INTERVIEW_TOOL) {
        this.completionPending = true;
        this.liveSession?.sendToolResponse({
          functionResponses: {
            id: call.id,
            name: call.name,
            response: { output: { accepted: true } },
          },
        });
        continue;
      }

      if (call.name !== INTERVIEW_REQUIREMENTS_TOOL) continue;

      try {
        const requirements = parseRequirements(call.args);
        this.emitState("generating-interview");
        const result = await this.requirementsOperation.run(requirements);
        this.completionPending = true;
        this.liveSession?.sendToolResponse({
          functionResponses: {
            id: call.id,
            name: call.name,
            response: {
              output: { success: true, interviewId: result.interviewId },
            },
          },
        });
      } catch (error) {
        this.liveSession?.sendToolResponse({
          functionResponses: {
            id: call.id,
            name: call.name,
            response: {
              error:
                "The interview could not be created. The application will offer a retry; do not collect the preferences again.",
            },
          },
        });
        const appError = toAppError(error);
        this.emitError(
          appError.code === "unknown"
            ? {
                ...appError,
                code: "generation",
                title: "Interview couldn't be created",
                message:
                  "We couldn't generate your interview questions. Your interview preferences have not been lost.",
              }
            : appError
        );
      }
    }
  }

  private createInterview(requirements: InterviewRequirements) {
    return postJson<InterviewGenerationResponse>(
      "/api/interviews/generate",
      { ...requirements, operationId: this.config!.operationId },
      this.config?.apiKey
    );
  }

  private flushInputTranscript() {
    const content = this.inputTranscript.trim();
    this.inputTranscript = "";
    if (content) {
      this.emitTranscript({
        role: "user",
        content,
        timestamp: Date.now(),
        final: true,
      });
    }
    this.resolveTranscriptWaiters();
  }

  private flushOutputTranscript() {
    const content = this.outputTranscript.trim();
    this.outputTranscript = "";
    if (content) {
      this.emitTranscript({
        role: "assistant",
        content,
        timestamp: Date.now(),
        final: true,
      });
    }
    this.resolveTranscriptWaiters();
  }

  private flushTranscripts() {
    this.flushInputTranscript();
    this.flushOutputTranscript();
  }

  private waitForStableTranscripts() {
    if (!this.inputTranscript && !this.outputTranscript) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(timeout);
        this.transcriptWaiters.delete(finish);
        resolve();
      };
      const timeout = window.setTimeout(finish, 750);
      this.transcriptWaiters.add(finish);
    });
  }

  private resolveTranscriptWaiters() {
    if (this.inputTranscript || this.outputTranscript) return;
    this.transcriptWaiters.forEach((resolve) => resolve());
    this.transcriptWaiters.clear();
  }

  private async finishFromModel() {
    if (this.stopping) return;
    await this.player.waitForIdle();
    const reason = this.config?.kind === "generate" ? "generation" : "interview";
    await this.stop();
    this.emitComplete(reason);
  }

  private async handleRuntimeFailure(error: unknown) {
    if (this.runtimeFailed || this.stopping) return;
    this.runtimeFailed = true;
    const appError = classifyGeminiError(error);
    await this.cleanup();
    this.emitError(appError);
  }

  private async cleanup() {
    this.stopping = true;
    this.liveSession?.close();
    this.liveSession = undefined;
    await this.microphone?.stop();
    this.microphone = undefined;
    await this.player.close();
    this.resolveTranscriptWaiters();
    this.stopping = false;
  }
}
