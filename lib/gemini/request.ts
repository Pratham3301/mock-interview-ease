import "server-only";

const BYOK_HEADER = "x-gemini-api-key";

export function temporaryApiKeyFromRequest(request: Request) {
  const apiKey = request.headers.get(BYOK_HEADER)?.trim();
  if (!apiKey) return undefined;
  if (apiKey.length > 256 || /[\r\n]/.test(apiKey)) {
    throw new Error("Invalid Gemini API key.");
  }
  return apiKey;
}

export function redactGeminiError(error: unknown) {
  if (process.env.NODE_ENV !== "development") return;
  const details =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof details?.message === "string"
        ? details.message
        : String(error);
  console.error("Gemini request failed", {
    status: details?.status ?? details?.statusCode,
    message: message.replace(/AIza[\w-]+/g, "[REDACTED_API_KEY]"),
  });
}
