import { EndSensitivity, StartSensitivity } from "@google/genai";

function integerSetting(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sensitivitySetting(
  value: string | undefined,
  high: StartSensitivity | EndSensitivity,
  low: StartSensitivity | EndSensitivity
) {
  return value?.trim().toLowerCase() === "low" ? low : high;
}

export const geminiVadConfig = {
  automaticActivityDetection: {
    disabled: false,
    startOfSpeechSensitivity: sensitivitySetting(
      process.env.NEXT_PUBLIC_GEMINI_VAD_START_SENSITIVITY,
      StartSensitivity.START_SENSITIVITY_HIGH,
      StartSensitivity.START_SENSITIVITY_LOW
    ) as StartSensitivity,
    endOfSpeechSensitivity: sensitivitySetting(
      process.env.NEXT_PUBLIC_GEMINI_VAD_END_SENSITIVITY,
      EndSensitivity.END_SENSITIVITY_HIGH,
      EndSensitivity.END_SENSITIVITY_LOW
    ) as EndSensitivity,
    prefixPaddingMs: integerSetting(
      process.env.NEXT_PUBLIC_GEMINI_VAD_PREFIX_PADDING_MS,
      40,
      0,
      1_000
    ),
    silenceDurationMs: integerSetting(
      process.env.NEXT_PUBLIC_GEMINI_VAD_SILENCE_MS,
      500,
      100,
      2_000
    ),
  },
};

export const geminiHybridVadEnabled =
  process.env.NEXT_PUBLIC_GEMINI_HYBRID_VAD?.trim().toLowerCase() !== "false";

export const geminiClientSilenceDurationMs = integerSetting(
  process.env.NEXT_PUBLIC_GEMINI_CLIENT_VAD_SILENCE_MS,
  450,
  200,
  2_000
);
