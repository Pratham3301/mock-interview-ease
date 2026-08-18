"use server";

import { generateObject } from "ai";

import { db } from "@/firebase/admin";
import {
  feedbackCategoryNames,
  feedbackSchema,
} from "@/constants";
import { getCurrentUser } from "@/lib/actions/auth.action";
import { feedbackDocumentId } from "@/lib/feedback/idempotency";
import { classifyGeminiError, type AppError } from "@/lib/gemini/errors";
import { getFlashModel, redactGeminiError } from "@/lib/gemini/server";

type CreateFeedbackResult =
  | { success: true; feedbackId: string }
  | { success: false; error: AppError };

export interface StoredTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  final: true;
}

function normalizeTranscript(
  transcript: CreateFeedbackParams["transcript"]
): StoredTranscriptMessage[] {
  return transcript
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim()
    )
    .slice(-200)
    .map((message, index) => ({
      role: message.role,
      content: message.content.trim().slice(0, 8_000),
      timestamp: message.timestamp ?? Date.now() + index,
      final: true,
    }));
}

export async function createFeedback(
  params: CreateFeedbackParams
): Promise<CreateFeedbackResult> {
  const { interviewId, userId, transcript, feedbackId, temporaryApiKey } =
    params;

  try {
    const currentUser = await getCurrentUser();
    if (!currentUser || currentUser.id !== userId) {
      throw { status: 401, message: "Authentication required." };
    }

    const stableTranscript = normalizeTranscript(transcript);
    if (!stableTranscript.length) {
      throw new Error("No completed transcript turns were available.");
    }

    const pendingFeedbackRef = db
      .collection("pendingFeedback")
      .doc(feedbackDocumentId(userId, interviewId));
    await pendingFeedbackRef.set({
      interviewId,
      userId,
      transcript: stableTranscript,
      updatedAt: new Date().toISOString(),
    });

    const formattedTranscript = stableTranscript
      .map(
        (sentence: { role: string; content: string }) =>
          `- ${sentence.role}: ${sentence.content}\n`
      )
      .join("");

    const { model } = getFlashModel(temporaryApiKey);
    const { object } = await generateObject({
      model: model,
      providerOptions: {
        google: {
          structuredOutputs: false,
        },
      },
      schema: feedbackSchema,
      prompt: `
        You are an AI interviewer analyzing a mock interview. Your task is to evaluate the candidate based on structured categories. Be thorough and detailed in your analysis. Don't be lenient with the candidate. If there are mistakes or areas for improvement, point them out.
        Transcript:
        ${formattedTranscript}

        Please score the candidate from 0 to 100 in the following areas. Do not add categories other than the ones provided:
        - **Communication Skills**: Clarity, articulation, structured responses.
        - **Technical Knowledge**: Understanding of key concepts for the role.
        - **Problem Solving**: Ability to analyze problems and propose solutions.
        - **Cultural Fit**: Alignment with company values and job role.
        - **Confidence and Clarity**: Confidence in responses, engagement, and clarity.
        Include each category exactly once using these exact category names.
        `,
      system:
        "You are a professional interviewer analyzing a mock interview. Your task is to evaluate the candidate based on structured categories",
    });

    const categoryScores = feedbackCategoryNames.map((name) => {
      const category = object.categoryScores.find(
        (candidate) => candidate.name === name
      );
      if (!category) {
        throw new Error(`Gemini omitted the ${name} feedback category.`);
      }
      return category;
    });

    const feedback = {
      interviewId: interviewId,
      userId: userId,
      totalScore: object.totalScore,
      categoryScores,
      strengths: object.strengths,
      areasForImprovement: object.areasForImprovement,
      finalAssessment: object.finalAssessment,
      createdAt: new Date().toISOString(),
    };

    let feedbackRef;

    if (feedbackId) {
      feedbackRef = db.collection("feedback").doc(feedbackId);
    } else {
      const existing = await db
        .collection("feedback")
        .where("interviewId", "==", interviewId)
        .where("userId", "==", userId)
        .limit(1)
        .get();
      feedbackRef = existing.empty
        ? db
            .collection("feedback")
            .doc(feedbackDocumentId(userId, interviewId))
        : existing.docs[0].ref;
    }

    const batch = db.batch();
    batch.set(feedbackRef, feedback);
    batch.delete(pendingFeedbackRef);
    await batch.commit();

    return { success: true, feedbackId: feedbackRef.id };
  } catch (error) {
    redactGeminiError(error);
    return { success: false, error: classifyGeminiError(error) };
  }
}

export async function getPendingFeedbackTranscript(
  interviewId: string
): Promise<StoredTranscriptMessage[]> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return [];

  const snapshot = await db
    .collection("pendingFeedback")
    .doc(feedbackDocumentId(currentUser.id, interviewId))
    .get();
  const data = snapshot.data();
  if (!data || data.userId !== currentUser.id || !Array.isArray(data.transcript)) {
    return [];
  }

  return normalizeTranscript(data.transcript as CreateFeedbackParams["transcript"]);
}

export async function getInterviewById(id: string): Promise<Interview | null> {
  const interview = await db.collection("interviews").doc(id).get();

  return interview.data() as Interview | null;
}

export async function getFeedbackByInterviewId(
  params: GetFeedbackByInterviewIdParams
): Promise<Feedback | null> {
  const { interviewId, userId } = params;

  const querySnapshot = await db
    .collection("feedback")
    .where("interviewId", "==", interviewId)
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (querySnapshot.empty) return null;

  const feedbackDoc = querySnapshot.docs[0];
  return { id: feedbackDoc.id, ...feedbackDoc.data() } as Feedback;
}

export async function getLatestInterviews(
  params: GetLatestInterviewsParams
): Promise<Interview[] | null> {
  const { userId, limit = 20 } = params;

  if (!userId) return null;

  const interviews = await db
    .collection("interviews")
    .orderBy("createdAt", "desc")
    .where("finalized", "==", true)
    .where("userId", "!=", userId)
    .limit(limit)
    .get();

  return interviews.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as Interview[];
}

export async function getInterviewsByUserId(
  userId: string
): Promise<Interview[] | null> {
  if (!userId) return null;

  const interviews = await db
    .collection("interviews")
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .get();

  return interviews.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as Interview[];
}
