export type VoiceErrorCode =
  | "quota"
  | "authentication"
  | "model-unavailable"
  | "network"
  | "microphone-denied"
  | "browser-unsupported"
  | "voice-playback"
  | "generation"
  | "feedback"
  | "unknown";

export interface AppError {
  code: VoiceErrorCode;
  title: string;
  message: string;
  retryable: boolean;
  fallbackAvailable: boolean;
  byokAvailable: boolean;
  technicalMessage?: string;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return [
      value.status,
      value.statusCode,
      value.code,
      value.message,
      value.reason,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return "Unknown error";
}

export function classifyGeminiError(
  error: unknown,
  status?: number
): AppError {
  const errorRecord =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  const reportedStatus = Number(
    status ?? errorRecord?.status ?? errorRecord?.statusCode
  );
  const technicalMessage = errorText(error);
  const normalized = technicalMessage.toLowerCase();
  const modelUnavailable =
    reportedStatus === 404 ||
    /model.*(not found|does not exist|deprecated|not supported|unsupported|unavailable|not available)|not supported.*live|live.*not supported|not supported.*bidigeneratecontent/.test(
      normalized
    );

  if (
    reportedStatus === 429 ||
    /resource[_ -]?exhausted|quota|rate.?limit|too many requests/.test(
      normalized
    )
  ) {
    return {
      code: "quota",
      title: "Interview service quota reached",
      message:
        "The shared Gemini quota is currently unavailable. You can retry later or continue with your own Gemini API key.",
      retryable: false,
      fallbackAvailable: true,
      byokAvailable: true,
      technicalMessage,
    };
  }

  if (modelUnavailable) {
    return {
      code: "model-unavailable",
      title: "Live voice is temporarily unavailable",
      message:
        "The configured Live model is unavailable, so another voice mode can be used instead.",
      retryable: false,
      fallbackAvailable: true,
      byokAvailable: true,
      technicalMessage,
    };
  }

  if (
    reportedStatus === 401 ||
    reportedStatus === 403 ||
    /api.?key|unauthenticated|permission.?denied|forbidden|credentials/.test(
      normalized
    )
  ) {
    return {
      code: "authentication",
      title: "Interview service is unavailable",
      message:
        "Gemini could not authenticate this session. You can try your own Gemini API key or go back.",
      retryable: false,
      fallbackAvailable: false,
      byokAvailable: true,
      technicalMessage,
    };
  }

  if (
    reportedStatus === 502 ||
    reportedStatus === 503 ||
    reportedStatus === 504 ||
    /network|websocket|socket|connection|timed? ?out|fetch failed|service unavailable/.test(
      normalized
    )
  ) {
    return {
      code: "network",
      title: "Interview couldn't be started",
      message:
        "We couldn't connect to the interview service. Check your connection and try again.",
      retryable: true,
      fallbackAvailable: true,
      byokAvailable: false,
      technicalMessage,
    };
  }

  return {
    code: "unknown",
    title: "Interview couldn't be started",
    message: "The interview service could not start. Please try again.",
    retryable: true,
    fallbackAvailable: true,
    byokAvailable: false,
    technicalMessage,
  };
}

export function microphoneError(error: unknown): AppError {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      code: "microphone-denied",
      title: "Microphone access is required",
      message:
        "Allow microphone access in your browser to continue with the voice interview.",
      retryable: true,
      fallbackAvailable: false,
      byokAvailable: false,
    };
  }

  return {
    code: "browser-unsupported",
    title: "Microphone couldn't be started",
    message:
      "This browser could not start microphone capture. Check your browser settings and try again.",
    retryable: true,
    fallbackAvailable: false,
    byokAvailable: false,
    technicalMessage: errorText(error),
  };
}

export function errorResponse(error: unknown, fallbackStatus = 500) {
  const appError = classifyGeminiError(error);
  const status =
    appError.code === "quota"
      ? 429
      : appError.code === "authentication"
        ? 401
        : appError.code === "model-unavailable"
          ? 503
          : fallbackStatus;

  return Response.json(
    {
      success: false,
      error: {
        code: appError.code,
        title: appError.title,
        message: appError.message,
        retryable: appError.retryable,
        fallbackAvailable: appError.fallbackAvailable,
        byokAvailable: appError.byokAvailable,
      },
    },
    { status }
  );
}
