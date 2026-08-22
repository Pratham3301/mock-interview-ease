// Ephemeral authentication tokens are currently supported by the constrained
// Gemini Live endpoint on v1alpha. The browser must use the same API version.
export const GEMINI_LIVE_API_VERSION = "v1alpha";

export interface GeminiLiveTokenRequest {
  uses: number;
  expireTime: string;
  newSessionExpireTime: string;
  bidiGenerateContentSetup: {
    model: string;
  };
  fieldMask: string;
}

export function buildGeminiLiveTokenRequest(
  model: string,
  now = Date.now()
): GeminiLiveTokenRequest {
  return {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
    // These are REST wire fields, not the similarly named SDK input fields.
    // Locking the model still allows the browser to provide its per-interview
    // system instruction and function declarations when opening the session.
    bidiGenerateContentSetup: {
      model: `models/${model.replace(/^models\//, "")}`,
    },
    fieldMask: "model",
  };
}
