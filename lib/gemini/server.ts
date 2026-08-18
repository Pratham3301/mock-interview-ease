import "server-only";

import { createGoogleGenerativeAI } from "@ai-sdk/google";

import { getGeminiServerConfig } from "./config";
export { redactGeminiError, temporaryApiKeyFromRequest } from "./request";

export function getFlashModel(temporaryApiKey?: string) {
  const config = getGeminiServerConfig(temporaryApiKey);
  const provider = createGoogleGenerativeAI({ apiKey: config.apiKey });
  return {
    model: provider(config.flashModel),
    modelName: config.flashModel,
  };
}
