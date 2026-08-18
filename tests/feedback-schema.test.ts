import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";

import { feedbackCategoryNames, feedbackSchema } from "@/constants";

describe("feedback schema", () => {
  it("uses one reusable array item schema accepted by Gemini", () => {
    const jsonSchema = zodSchema(feedbackSchema).jsonSchema as {
      properties?: {
        categoryScores?: { items?: unknown };
      };
    };

    expect(Array.isArray(jsonSchema.properties?.categoryScores?.items)).toBe(
      false
    );
    expect(jsonSchema.properties?.categoryScores?.items).toBeTypeOf("object");
  });

  it("accepts every required category exactly once", () => {
    const result = feedbackSchema.parse({
      totalScore: 80,
      categoryScores: feedbackCategoryNames.map((name) => ({
        name,
        score: 80,
        comment: "Clear evidence from the interview.",
      })),
      strengths: ["Clear communication"],
      areasForImprovement: ["Add more examples"],
      finalAssessment: "A solid interview with room to improve.",
    });

    expect(result.categoryScores.map((category) => category.name)).toEqual(
      feedbackCategoryNames
    );
  });
});
