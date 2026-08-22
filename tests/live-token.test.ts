import { describe, expect, it } from "vitest";

import {
  buildGeminiLiveTokenRequest,
  GEMINI_LIVE_API_VERSION,
} from "@/lib/gemini/live-token";

describe("Gemini Live ephemeral token request", () => {
  it("uses the v1alpha constrained Live API", () => {
    expect(GEMINI_LIVE_API_VERSION).toBe("v1alpha");
  });

  it("uses REST wire fields and locks the selected model", () => {
    const request = buildGeminiLiveTokenRequest(
      "gemini-3.1-flash-live-preview",
      Date.parse("2026-08-18T12:00:00.000Z")
    );

    expect(request).toMatchObject({
      uses: 1,
      bidiGenerateContentSetup: {
        model: "models/gemini-3.1-flash-live-preview",
      },
      fieldMask: "model",
      expireTime: "2026-08-18T12:30:00.000Z",
      newSessionExpireTime: "2026-08-18T12:01:00.000Z",
    });
    expect(request).not.toHaveProperty("liveConnectConstraints");
    expect(request).not.toHaveProperty("lockAdditionalFields");
  });
});
