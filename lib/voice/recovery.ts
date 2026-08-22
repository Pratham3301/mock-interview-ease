import { classifyGeminiError, type AppError } from "@/lib/gemini/errors";

export type RecoveryDecision = "retry-live" | "fallback" | "surface-error";

export function decideVoiceRecovery(
  error: AppError,
  attempt: number,
  fallbackSupported: boolean,
): RecoveryDecision {
  if (error.code === "network" && attempt < 2) return "retry-live";
  if (
    fallbackSupported &&
    (error.code === "network" ||
      error.code === "model-unavailable" ||
      error.code === "quota" ||
      error.code === "unknown")
  ) {
    return "fallback";
  }
  return "surface-error";
}

export function retryDelay(attempt: number) {
  return Math.min(1_500, 350 * 2 ** attempt);
}

function isAppError(error: unknown): error is AppError {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    "title" in error,
  );
}

interface EstablishVoiceModeOptions {
  startLive: () => Promise<void>;
  startFallback: () => Promise<void>;
  fallbackSupported: boolean;
  forceFallback?: boolean;
  onRetry?: (attempt: number) => void;
  pause?: (milliseconds: number) => Promise<void>;
}

export async function establishVoiceMode({
  startLive,
  startFallback,
  fallbackSupported,
  forceFallback = false,
  onRetry,
  pause = (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}: EstablishVoiceModeOptions): Promise<"live" | "fallback"> {
  if (forceFallback) {
    await startFallback();
    return "fallback";
  }

  let lastError: AppError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt > 0) {
        onRetry?.(attempt);
        await pause(retryDelay(attempt - 1));
      }
      await startLive();
      return "live";
    } catch (error) {
      lastError = isAppError(error) ? error : classifyGeminiError(error);
      const decision = decideVoiceRecovery(
        lastError,
        attempt,
        fallbackSupported,
      );
      if (decision === "retry-live") continue;
      if (decision === "fallback") {
        await startFallback();
        return "fallback";
      }
      throw lastError;
    }
  }

  throw lastError ?? classifyGeminiError("Live voice failed to start");
}
