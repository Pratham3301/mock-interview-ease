import { describe, expect, it, vi } from "vitest";

import { classifyGeminiError } from "@/lib/gemini/errors";
import {
  DEFAULT_GEMINI_LEGACY_LIVE_MODEL,
  chooseLiveModel,
} from "@/lib/gemini/live-models";
import { establishVoiceMode } from "@/lib/voice/recovery";

const noPause = async () => {};

describe("voice startup recovery", () => {
  it("keeps Gemini Live as the primary mode after a successful connection", async () => {
    const startLive = vi.fn().mockResolvedValue(undefined);
    const startFallback = vi.fn().mockResolvedValue(undefined);

    await expect(
      establishVoiceMode({
        startLive,
        startFallback,
        fallbackSupported: true,
        pause: noPause,
      })
    ).resolves.toBe("live");
    expect(startLive).toHaveBeenCalledOnce();
    expect(startFallback).not.toHaveBeenCalled();
  });

  it.each([
    new Error("configured model does not exist"),
    new Error("model does not support Live API"),
    new Error("model is not supported for bidiGenerateContent"),
  ])("uses fallback when Live is unavailable: %s", async (liveError) => {
    const startFallback = vi.fn().mockResolvedValue(undefined);

    await expect(
      establishVoiceMode({
        startLive: vi.fn().mockRejectedValue(liveError),
        startFallback,
        fallbackSupported: true,
        pause: noPause,
      })
    ).resolves.toBe("fallback");
    expect(startFallback).toHaveBeenCalledOnce();
  });

  it("retries a transient connection failure with bounded backoff", async () => {
    const startLive = vi
      .fn()
      .mockRejectedValueOnce(new Error("WebSocket connection failed"))
      .mockResolvedValueOnce(undefined);
    const onRetry = vi.fn();

    await expect(
      establishVoiceMode({
        startLive,
        startFallback: vi.fn(),
        fallbackSupported: true,
        onRetry,
        pause: noPause,
      })
    ).resolves.toBe("live");
    expect(startLive).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("classifies quota exhaustion as actionable BYOK state", () => {
    const error = classifyGeminiError("RESOURCE_EXHAUSTED: quota exceeded", 429);
    expect(error.code).toBe("quota");
    expect(error.byokAvailable).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("recognizes quota status codes reported by SDK errors", () => {
    const error = classifyGeminiError({
      statusCode: 429,
      message: "Gemini request failed",
    });
    expect(error.code).toBe("quota");
    expect(error.byokAvailable).toBe(true);
  });

  it("uses the official older native-audio model for the second Live attempt", () => {
    const choice = chooseLiveModel(
      "gemini-3.1-flash-live-preview",
      DEFAULT_GEMINI_LEGACY_LIVE_MODEL,
      1
    );

    expect(choice).toEqual({
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
      legacy: true,
      attempt: 1,
    });
  });

  it("does not label a duplicate fallback model as older", () => {
    const choice = chooseLiveModel("same-model", "same-model", 1);
    expect(choice).toEqual({
      model: "same-model",
      legacy: false,
      attempt: 0,
    });
  });

  it("recognizes model access failures before generic 403 authentication", () => {
    const error = classifyGeminiError({
      status: 403,
      message: "The model is unavailable to this project",
    });
    expect(error.code).toBe("model-unavailable");
  });
});
