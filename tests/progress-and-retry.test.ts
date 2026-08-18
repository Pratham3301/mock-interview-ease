import { describe, expect, it, vi } from "vitest";

import { feedbackDocumentId } from "@/lib/feedback/idempotency";
import { RetainedOperation } from "@/lib/voice/operations";
import {
  readStoredTranscript,
  storeTranscript,
  TranscriptBuffer,
} from "@/lib/voice/progress";

describe("progress preservation and idempotency", () => {
  it("retains interview generation parameters for retry", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ interviewId: "created" });
    const operation = new RetainedOperation(execute);
    const requirements = { role: "Engineer", amount: 5 };

    await expect(operation.run(requirements)).rejects.toThrow();
    await expect(operation.retry()).resolves.toEqual({ interviewId: "created" });
    expect(execute).toHaveBeenNthCalledWith(1, requirements);
    expect(execute).toHaveBeenNthCalledWith(2, requirements);
  });

  it("prevents concurrent duplicate operations", async () => {
    let resolve!: (value: string) => void;
    const execute = vi.fn(
      () => new Promise<string>((nextResolve) => (resolve = nextResolve))
    );
    const operation = new RetainedOperation(execute);

    const first = operation.run("same request");
    const second = operation.run("same request");
    resolve("done");

    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps only final transcript turns after a feedback failure", () => {
    const buffer = new TranscriptBuffer();
    buffer.append({
      role: "user",
      content: "partial answer",
      timestamp: 1,
      final: false,
    });
    buffer.append({
      role: "user",
      content: "final answer",
      timestamp: 2,
      final: true,
    });

    expect(buffer.snapshot()).toEqual([
      {
        role: "user",
        content: "final answer",
        timestamp: 2,
        final: true,
      },
    ]);
  });

  it("uses the same feedback document ID for every retry", () => {
    const first = feedbackDocumentId("user-1", "interview-1");
    const retry = feedbackDocumentId("user-1", "interview-1");
    expect(retry).toBe(first);
  });

  it("reloads the same final transcript for a feedback retry", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const transcript = [
      {
        role: "user" as const,
        content: "My completed answer",
        timestamp: 10,
        final: true as const,
      },
    ];

    storeTranscript(storage, "interview-1", transcript);
    expect(readStoredTranscript(storage, "interview-1")).toEqual(transcript);
  });
});
