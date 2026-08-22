import { generateText } from "ai";
import { z } from "zod";

import { db } from "@/firebase/admin";
import { getCurrentUser } from "@/lib/actions/auth.action";
import { errorResponse } from "@/lib/gemini/errors";
import {
  getFlashModel,
  redactGeminiError,
  temporaryApiKeyFromRequest,
} from "@/lib/gemini/server";
import { getRandomInterviewCover } from "@/lib/utils";

const generationSchema = z.object({
  role: z.string().trim().min(1).max(120),
  level: z.string().trim().min(1).max(120),
  techstack: z.string().trim().min(1).max(500),
  type: z.string().trim().min(1).max(120),
  amount: z.coerce.number().int().min(1).max(20),
  operationId: z.string().uuid(),
});

function parseQuestions(value: string, expectedAmount: number) {
  const withoutFence = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(withoutFence);
  const questions = z.array(z.string().trim().min(1)).parse(parsed);
  if (questions.length !== expectedAmount) {
    throw new Error("Gemini returned an unexpected number of questions.");
  }
  return questions;
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      { success: false, error: { message: "Authentication required." } },
      { status: 401 }
    );
  }

  let input: z.infer<typeof generationSchema> | undefined;

  try {
    input = generationSchema.parse(await request.json());
    const temporaryApiKey = temporaryApiKeyFromRequest(request);
    const { model } = getFlashModel(temporaryApiKey);
    const { text } = await generateText({
      model,
      prompt: `Prepare questions for a job interview.
The job role is ${input.role}.
The job experience level is ${input.level}.
The tech stack used in the job is: ${input.techstack}.
The focus between behavioral and technical questions should lean towards: ${input.type}.
The exact amount of questions required is: ${input.amount}.
Return only a JSON array of question strings without markdown or additional text.
The questions will be read aloud, so avoid slash, asterisk, and other notation that sounds unnatural in speech.`,
    });
    const questions = parseQuestions(text, input.amount);

    const interview = {
      role: input.role,
      type: input.type,
      level: input.level,
      techstack: input.techstack
        .split(",")
        .map((technology) => technology.trim())
        .filter(Boolean),
      questions,
      userId: user.id,
      finalized: true,
      coverImage: getRandomInterviewCover(),
      createdAt: new Date().toISOString(),
    };

    const interviewRef = db.collection("interviews").doc(input.operationId);
    await interviewRef.create(interview).catch(async (error: unknown) => {
      const code = (error as { code?: number | string }).code;
      if (code !== 6 && code !== "already-exists") throw error;

      const existingInterview = await interviewRef.get();
      if (existingInterview.data()?.userId !== user.id) {
        throw new Error("Interview generation operation conflicted.");
      }
    });

    return Response.json(
      { success: true, interviewId: interviewRef.id },
      { status: 200 }
    );
  } catch (error) {
    redactGeminiError(error);
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return Response.json(
        {
          success: false,
          error: {
            code: "generation",
            title: "Interview couldn't be created",
            message:
              "We couldn't generate your interview questions. Your interview preferences have not been lost.",
            retryable: true,
          },
        },
        { status: 400 }
      );
    }
    return errorResponse(error);
  }
}
