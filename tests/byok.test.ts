import { describe, expect, it } from "vitest";

import {
  getTemporaryGeminiKey,
  maskApiKey,
  removeTemporaryGeminiKey,
  setTemporaryGeminiKey,
  type SessionStorageLike,
} from "@/lib/gemini/byok";

function memoryStorage(): SessionStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("temporary Gemini API keys", () => {
  it("stores only for the session and removes the key on request", () => {
    const storage = memoryStorage();
    setTemporaryGeminiKey(storage, "AIza-example-secret-4Fk");
    expect(getTemporaryGeminiKey(storage)).toBe("AIza-example-secret-4Fk");

    removeTemporaryGeminiKey(storage);
    expect(getTemporaryGeminiKey(storage)).toBe("");
  });

  it("masks keys before displaying them", () => {
    const masked = maskApiKey("AIza-example-secret-4Fk");
    expect(masked).toMatch(/^AIza/);
    expect(masked).toMatch(/4Fk$/);
    expect(masked).not.toContain("example-secret");
  });
});
