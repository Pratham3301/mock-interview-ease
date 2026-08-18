import type { AppError } from "@/lib/gemini/errors";
import { classifyGeminiError } from "@/lib/gemini/errors";

interface ApiErrorBody {
  error?: Partial<AppError> & { message?: string };
}

export class VoiceRequestError extends Error {
  constructor(public readonly appError: AppError) {
    super(appError.message);
    this.name = "VoiceRequestError";
  }
}

export function apiKeyHeaders(apiKey?: string) {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-gemini-api-key"] = apiKey;
  return headers;
}

export async function postJson<T>(
  url: string,
  body: unknown,
  apiKey?: string
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...apiKeyHeaders(apiKey),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new VoiceRequestError(classifyGeminiError(error));
  }

  const payload = (await response.json().catch(() => ({}))) as ApiErrorBody;
  if (!response.ok) {
    const classified = classifyGeminiError(
      payload.error?.message ?? response.statusText,
      response.status
    );
    throw new VoiceRequestError({
      ...classified,
      ...payload.error,
      technicalMessage: classified.technicalMessage,
    });
  }

  return payload as T;
}

export function toAppError(error: unknown) {
  return error instanceof VoiceRequestError
    ? error.appError
    : classifyGeminiError(error);
}
