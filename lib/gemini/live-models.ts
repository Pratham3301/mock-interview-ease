export const DEFAULT_GEMINI_LIVE_MODEL =
  "gemini-3.1-flash-live-preview";
export const DEFAULT_GEMINI_LEGACY_LIVE_MODEL =
  "gemini-2.5-flash-native-audio-preview-12-2025";

export interface GeminiLiveModelChoice {
  model: string;
  legacy: boolean;
  attempt: number;
}

export function chooseLiveModel(
  primaryModel: string,
  legacyModel: string,
  requestedAttempt = 0
): GeminiLiveModelChoice {
  const models = [primaryModel, legacyModel].filter(
    (model, index, candidates) => candidates.indexOf(model) === index
  );
  const attempt = requestedAttempt === 1 && models.length > 1 ? 1 : 0;

  return {
    model: models[attempt],
    legacy: attempt > 0,
    attempt,
  };
}
