const STORAGE_KEY = "prepwise:gemini-api-key";

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function getTemporaryGeminiKey(storage: SessionStorageLike) {
  return storage.getItem(STORAGE_KEY) ?? "";
}

export function setTemporaryGeminiKey(
  storage: SessionStorageLike,
  apiKey: string
) {
  const normalized = apiKey.trim();
  if (!normalized) throw new Error("Enter a Gemini API key.");
  storage.setItem(STORAGE_KEY, normalized);
}

export function removeTemporaryGeminiKey(storage: SessionStorageLike) {
  storage.removeItem(STORAGE_KEY);
}

export function maskApiKey(apiKey: string) {
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 4)}${"•".repeat(12)}${apiKey.slice(-3)}`;
}
