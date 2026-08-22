import "server-only";

import {
  DEFAULT_GEMINI_LEGACY_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_MODEL,
  chooseLiveModel,
  type GeminiLiveModelChoice,
} from "./live-models";

export const GEMINI_LIVE_VOICE = "Aoede";

const DEFAULT_FLASH_MODEL = "gemini-3.7-flash";

export interface GeminiServerConfig {
  apiKey: string;
  liveModel: string;
  legacyLiveModel: string;
  flashModel: string;
}

export function getGeminiServerConfig(
  temporaryApiKey?: string
): GeminiServerConfig {
  const apiKey =
    temporaryApiKey?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Gemini API key is not configured.");
  }

  return {
    apiKey,
    liveModel:
      process.env.GEMINI_LIVE_MODEL?.trim() || DEFAULT_GEMINI_LIVE_MODEL,
    legacyLiveModel:
      process.env.GEMINI_LEGACY_LIVE_MODEL?.trim() ||
      DEFAULT_GEMINI_LEGACY_LIVE_MODEL,
    flashModel: process.env.GEMINI_FLASH_MODEL?.trim() || DEFAULT_FLASH_MODEL,
  };
}

export function getLiveModelChoice(
  config: GeminiServerConfig,
  requestedAttempt = 0
): GeminiLiveModelChoice {
  return chooseLiveModel(
    config.liveModel,
    config.legacyLiveModel,
    requestedAttempt
  );
}
