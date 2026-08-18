import { getCurrentUser } from "@/lib/actions/auth.action";
import {
  getGeminiServerConfig,
  getLiveModelChoice,
} from "@/lib/gemini/config";
import { errorResponse } from "@/lib/gemini/errors";
import {
  buildGeminiLiveTokenRequest,
  GEMINI_LIVE_API_VERSION,
} from "@/lib/gemini/live-token";
import {
  redactGeminiError,
  temporaryApiKeyFromRequest,
} from "@/lib/gemini/request";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      { success: false, error: { message: "Authentication required." } },
      { status: 401 }
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      modelAttempt?: unknown;
    };
    const temporaryApiKey = temporaryApiKeyFromRequest(request);
    const config = getGeminiServerConfig(temporaryApiKey);
    const modelChoice = getLiveModelChoice(
      config,
      Number(body.modelAttempt) === 1 ? 1 : 0
    );
    const tokenRequest = buildGeminiLiveTokenRequest(modelChoice.model);

    const tokenResponse = await fetch(
      `https://generativelanguage.googleapis.com/${GEMINI_LIVE_API_VERSION}/auth_tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(tokenRequest),
      }
    );
    const token = (await tokenResponse.json().catch(() => ({}))) as {
      name?: string;
      error?: { message?: string };
    };

    if (!tokenResponse.ok) {
      throw {
        status: tokenResponse.status,
        message: token.error?.message || "Gemini token request failed.",
      };
    }

    if (!token.name) throw new Error("Gemini did not return an auth token.");

    return Response.json(
      {
        success: true,
        token: token.name,
        model: modelChoice.model,
        modelAttempt: modelChoice.attempt,
        legacyModel: modelChoice.legacy,
        apiVersion: GEMINI_LIVE_API_VERSION,
        expiresAt: tokenRequest.expireTime,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    redactGeminiError(error);
    return errorResponse(error);
  }
}
