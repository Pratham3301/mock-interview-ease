import { generateObject } from "ai";
import { z } from "zod";

import { getCurrentUser } from "@/lib/actions/auth.action";
import { errorResponse } from "@/lib/gemini/errors";
import {
  interviewCreationInstruction,
  mockInterviewInstruction,
} from "@/lib/gemini/prompts";
import {
  getFlashModel,
  redactGeminiError,
  temporaryApiKeyFromRequest,
} from "@/lib/gemini/server";

const transcriptSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
  final: z.literal(true),
  timestamp: z.number().optional(),
});

const requestSchema = z.object({
  kind: z.enum(["generate", "interview"]),
  userName: z.string().min(1).max(120),
  questions: z.array(z.string().min(1).max(1000)).max(30).optional(),
  transcript: z.array(transcriptSchema).max(120),
});

const requirementsSchema = z.object({
  role: z.string().min(1),
  level: z.string().min(1),
  techstack: z.string().min(1),
  type: z.string().min(1),
  amount: z.number().int().min(1).max(20),
});

const creationResponseSchema = z.object({
  response: z.string().min(1),
  requirements: requirementsSchema.nullable(),
});

const interviewResponseSchema = z.object({
  response: z.string().min(1),
  completed: z.boolean(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      { success: false, error: { message: "Authentication required." } },
      { status: 401 }
    );
  }

  try {
    const input = requestSchema.parse(await request.json());
    const temporaryApiKey = temporaryApiKeyFromRequest(request);
    const { model } = getFlashModel(temporaryApiKey);
    const history = input.transcript
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n")
      .slice(-24_000);

    if (input.kind === "generate") {
      const { object } = await generateObject({
        model,
        schema: creationResponseSchema,
        system: `${interviewCreationInstruction}\n\nYou are in compatibility voice mode. Return a short spoken response. Set requirements to null until every field has been collected and the user has confirmed them.`,
        prompt: `Conversation so far:\n${history}\n\nRespond to the latest user turn.`,
      });
      return Response.json({ success: true, ...object });
    }

    const { object } = await generateObject({
      model,
      schema: interviewResponseSchema,
      system: `${mockInterviewInstruction(input.userName, input.questions ?? [])}\n\nYou are in compatibility voice mode. Return only the next concise spoken interviewer response. Set completed to true only after every supplied primary question has been completed.`,
      prompt: `Conversation so far:\n${history}\n\nRespond to the latest user turn.`,
    });

    return Response.json({ success: true, ...object });
  } catch (error) {
    redactGeminiError(error);
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          success: false,
          error: {
            code: "generation",
            title: "Interview couldn't continue",
            message: "The conversation data was invalid. Please try again.",
            retryable: true,
          },
        },
        { status: 400 }
      );
    }
    return errorResponse(error);
  }
}
