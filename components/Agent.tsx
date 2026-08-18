"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useGeminiApiKey } from "@/components/GeminiApiKeyProvider";
import { createFeedback } from "@/lib/actions/general.action";
import {
  clearStoredTranscript,
  readStoredTranscript,
  storeTranscript,
} from "@/lib/voice/progress";
import { createVoiceSession } from "@/lib/voice";
import type {
  AppError,
  TranscriptMessage,
  VoiceMode,
  VoiceSession,
  VoiceSessionState,
} from "@/lib/voice";
import { cn } from "@/lib/utils";

const statusLabels: Record<VoiceSessionState, string> = {
  idle: "Ready",
  connecting: "Connecting…",
  listening: "Listening…",
  "user-speaking": "Listening…",
  "assistant-thinking": "Thinking…",
  "assistant-speaking": "Speaking…",
  "preparing-voice": "Preparing offline voice…",
  "generating-interview": "Generating interview…",
  "generating-feedback": "Generating feedback…",
  reconnecting: "Reconnecting…",
  ending: "Ending…",
  finished: "Finished",
  error: "Needs attention",
};

const activeStates = new Set<VoiceSessionState>([
  "connecting",
  "listening",
  "user-speaking",
  "assistant-thinking",
  "assistant-speaking",
  "preparing-voice",
  "generating-interview",
  "reconnecting",
]);

const feedbackError: AppError = {
  code: "feedback",
  title: "Feedback couldn't be generated",
  message:
    "Your interview was completed successfully, but we couldn't generate the feedback right now.",
  retryable: true,
  fallbackAvailable: false,
  byokAvailable: true,
};

const Agent = ({
  userName,
  userId,
  interviewId,
  feedbackId,
  type,
  questions,
  initialTranscript,
}: AgentProps) => {
  const router = useRouter();
  const { apiKey, requestApiKey } = useGeminiApiKey();
  const sessionRef = useRef<VoiceSession | undefined>(undefined);
  const messagesRef = useRef<TranscriptMessage[]>([]);
  const feedbackInFlight = useRef(false);
  const operationIdRef = useRef<string | undefined>(undefined);
  const savedApiKeyRef = useRef("");

  const [voiceState, setVoiceState] = useState<VoiceSessionState>("idle");
  const [lastMeaningfulState, setLastMeaningfulState] =
    useState<VoiceSessionState>("idle");
  const [voiceMode, setVoiceMode] = useState<VoiceMode>();
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<AppError>();

  const lastMessage = messages.at(-1)?.content ?? "";
  const isActive = activeStates.has(voiceState);
  const isBusy =
    isActive || voiceState === "ending" || voiceState === "generating-feedback";
  const isFeedbackRecovery =
    error?.code === "feedback" ||
    (lastMeaningfulState === "generating-feedback" && Boolean(interviewId));

  useEffect(() => {
    const session = createVoiceSession();
    sessionRef.current = session;

    const unsubscribers = [
      session.onTranscript((message) => {
        messagesRef.current = [...messagesRef.current, message];
        setMessages(messagesRef.current);
        if (type === "interview" && interviewId) {
          storeTranscript(sessionStorage, interviewId, messagesRef.current);
        }
      }),
      session.onStateChange((state) => {
        if (state !== "error") {
          setLastMeaningfulState(state);
        }
        setVoiceState(state);
      }),
      session.onModeChange((mode, nextNotice) => {
        setVoiceMode(mode);
        if (nextNotice) setNotice(nextNotice);
      }),
      session.onError((nextError) => setError(nextError)),
      session.onComplete((reason) => {
        if (reason === "generation") {
          router.push("/");
          router.refresh();
        } else {
          void generateFeedback(messagesRef.current);
        }
      }),
    ];

    if (type === "interview" && interviewId) {
      const stored = readStoredTranscript(sessionStorage, interviewId);
      const restored =
        (initialTranscript?.length ?? 0) >= stored.length
          ? (initialTranscript ?? [])
          : stored;
      if (restored.length) {
        messagesRef.current = restored;
        /* eslint-disable react-hooks/set-state-in-effect -- Restore persisted interview progress after the client session is available. */
        setMessages(restored);
        setError(feedbackError);
        /* eslint-enable react-hooks/set-state-in-effect */
      }
    }

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void session.stop();
      sessionRef.current = undefined;
    };
    // Session callbacks intentionally use refs so the provider is created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    savedApiKeyRef.current = apiKey;
    sessionRef.current?.setApiKey(apiKey || undefined);
  }, [apiKey]);

  async function generateFeedback(transcript: TranscriptMessage[]) {
    if (
      feedbackInFlight.current ||
      !interviewId ||
      !userId ||
      transcript.length === 0
    ) {
      if (!transcript.length) {
        setError({
          ...feedbackError,
          message:
            "No completed transcript turns were available for feedback. Please retake the interview.",
          retryable: false,
        });
      }
      return;
    }

    feedbackInFlight.current = true;
    setError(undefined);
    setLastMeaningfulState("generating-feedback");
    setVoiceState("generating-feedback");
    storeTranscript(sessionStorage, interviewId, transcript);

    try {
      const result = await createFeedback({
        interviewId,
        userId,
        transcript: transcript.map(({ role, content, timestamp, final }) => ({
          role,
          content,
          timestamp,
          final,
        })),
        feedbackId,
        temporaryApiKey: savedApiKeyRef.current || undefined,
      });

      if (!result.success) {
        setError(
          result.error.code === "unknown"
            ? feedbackError
            : { ...result.error, fallbackAvailable: false },
        );
        setVoiceState("error");
        return;
      }

      clearStoredTranscript(sessionStorage, interviewId);
      router.push(`/interview/${interviewId}/feedback`);
      router.refresh();
    } catch {
      setError(feedbackError);
      setVoiceState("error");
    } finally {
      feedbackInFlight.current = false;
    }
  }

  const handleStart = async (forceFallback = false) => {
    if (isBusy || !sessionRef.current || !userId) return;
    setError(undefined);
    setNotice("");

    if (!operationIdRef.current) operationIdRef.current = crypto.randomUUID();
    const initialTranscript =
      type === "interview" && interviewId
        ? readStoredTranscript(sessionStorage, interviewId)
        : messagesRef.current;

    await sessionRef.current.start({
      kind: type,
      userName,
      userId,
      interviewId,
      questions,
      initialTranscript,
      operationId: operationIdRef.current,
      apiKey: savedApiKeyRef.current || undefined,
      forceFallback,
    });
  };

  const handleEnd = async () => {
    if (!sessionRef.current || voiceState === "ending") return;
    await sessionRef.current.stop();
    if (type === "generate") {
      router.push("/");
    } else {
      await generateFeedback(messagesRef.current);
    }
  };

  const handleRetry = async () => {
    setError(undefined);
    if (isFeedbackRecovery) {
      await generateFeedback(messagesRef.current);
    } else {
      await sessionRef.current?.retry();
    }
  };

  const handleFallback = async () => {
    setError(undefined);
    await sessionRef.current?.useFallback();
  };

  const handleUseKey = async () => {
    const temporaryKey = await requestApiKey();
    if (!temporaryKey) return;

    savedApiKeyRef.current = temporaryKey;
    sessionRef.current?.setApiKey(temporaryKey);
    setError(undefined);
    if (isFeedbackRecovery) await generateFeedback(messagesRef.current);
    else await sessionRef.current?.retry();
  };

  const canUseFallback =
    Boolean(error?.fallbackAvailable) &&
    voiceMode !== "fallback" &&
    lastMeaningfulState !== "generating-interview";

  const modeLabel = useMemo(() => {
    if (voiceMode === "live") return "Gemini Live";
    if (voiceMode === "fallback") return "Compatibility voice · Kokoro";
    return "";
  }, [voiceMode]);

  return (
    <>
      <div className="call-view">
        <div className="card-interviewer">
          <div className="avatar">
            <Image
              src="/ai-avatar.png"
              alt="AI interviewer"
              width={65}
              height={54}
              className="object-cover"
            />
            {voiceState === "assistant-speaking" && (
              <span className="animate-speak" aria-hidden="true" />
            )}
          </div>
          <h3>AI Interviewer</h3>
          <p className="text-sm" aria-live="polite">
            {statusLabels[voiceState]}
          </p>
          {modeLabel && <p className="text-xs text-light-400">{modeLabel}</p>}
        </div>

        <div className="card-border">
          <div className="card-content">
            <Image
              src="/user-avatar.png"
              alt={`${userName}'s profile`}
              width={539}
              height={539}
              className="rounded-full object-cover size-[120px]"
            />
            <h3>{userName}</h3>
          </div>
        </div>
      </div>

      {notice && !error && (
        <div
          className="rounded-2xl border border-primary-200/30 bg-dark-200 px-5 py-3 text-center"
          role="status"
        >
          <p>{notice}</p>
        </div>
      )}

      {lastMessage && (
        <div className="transcript-border" aria-live="polite">
          <div className="transcript">
            <p
              key={lastMessage}
              className={cn(
                "transition-opacity duration-500 opacity-0",
                "animate-fadeIn opacity-100",
              )}
            >
              {lastMessage}
            </p>
          </div>
        </div>
      )}

      {error && (
        <section
          className="dark-gradient rounded-2xl border border-destructive-100/50 p-5 flex flex-col gap-4"
          role="alert"
          aria-live="assertive"
        >
          <div>
            <h3 className="text-xl">{error.title}</h3>
            <p className="mt-2">{error.message}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {error.retryable && (
              <Button className="btn-primary" onClick={handleRetry}>
                {isFeedbackRecovery ? "Retry feedback" : "Retry"}
              </Button>
            )}
            {canUseFallback && (
              <Button className="btn-secondary" onClick={handleFallback}>
                Use fallback voice
              </Button>
            )}
            {error.byokAvailable && (
              <Button className="btn-secondary" onClick={handleUseKey}>
                Use your API key
              </Button>
            )}
            <Button className="btn-secondary" onClick={() => router.push("/")}>
              Back
            </Button>
          </div>
        </section>
      )}

      <div className="w-full flex justify-center">
        {isActive ? (
          <button
            type="button"
            className="btn-disconnect"
            onClick={handleEnd}
            disabled={voiceState === "connecting" || voiceState === "ending"}
          >
            {type === "interview" ? "End Interview" : "End"}
          </button>
        ) : (
          !error && (
            <button
              type="button"
              className="relative btn-call disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => handleStart(false)}
              disabled={isBusy || voiceState === "finished"}
              aria-label={
                type === "interview" ? "Start interview" : "Start setup"
              }
            >
              <span
                className={cn(
                  "absolute animate-ping rounded-full opacity-75",
                  voiceState !== "connecting" && "hidden",
                )}
                aria-hidden="true"
              />
              <span className="relative">
                {voiceState === "connecting" ? "Connecting…" : "Call"}
              </span>
            </button>
          )
        )}
      </div>
    </>
  );
};

export default Agent;
