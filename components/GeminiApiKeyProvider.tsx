"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getTemporaryGeminiKey,
  maskApiKey,
  removeTemporaryGeminiKey,
  setTemporaryGeminiKey,
} from "@/lib/gemini/byok";

interface GeminiApiKeyContextValue {
  apiKey: string;
  requestApiKey(): Promise<string | undefined>;
}

const GeminiApiKeyContext = createContext<GeminiApiKeyContextValue | null>(
  null,
);

export function GeminiApiKeyProvider({ children }: { children: ReactNode }) {
  const resolverRef = useRef<(apiKey?: string) => void>(undefined);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [formError, setFormError] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setApiKey(getTemporaryGeminiKey(sessionStorage));
  }, []);

  const finishRequest = useCallback((value?: string) => {
    resolverRef.current?.(value);
    resolverRef.current = undefined;
    setOpen(false);
    setApiKeyInput("");
    setFormError("");
  }, []);

  const requestApiKey = useCallback(() => {
    resolverRef.current?.(undefined);
    setApiKeyInput("");
    setFormError("");
    setOpen(true);
    return new Promise<string | undefined>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finishRequest();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [finishRequest, open]);

  const handleSave = () => {
    setFormError("");
    try {
      setTemporaryGeminiKey(sessionStorage, apiKeyInput);
      const normalized = apiKeyInput.trim();
      setApiKey(normalized);
      finishRequest(normalized);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "The API key is invalid.",
      );
    }
  };

  const handleRemove = () => {
    removeTemporaryGeminiKey(sessionStorage);
    setApiKey("");
    finishRequest();
  };

  const value = useMemo(
    () => ({ apiKey, requestApiKey }),
    [apiKey, requestApiKey],
  );

  return (
    <GeminiApiKeyContext.Provider value={value}>
      {children}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) finishRequest();
          }}
        >
          <section
            className="dark-gradient w-full max-w-lg rounded-2xl border border-primary-200/40 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gemini-key-title"
            aria-describedby="gemini-key-description"
          >
            <h3 id="gemini-key-title">Use your own Gemini API key</h3>
            <p id="gemini-key-description" className="mt-2">
              This temporary key is used for Gemini Live, interview generation,
              compatibility mode, and feedback. It stays only in this browser
              session and is not saved to your account.
            </p>

            {apiKey && (
              <p className="mt-4 text-sm">Current key: {maskApiKey(apiKey)}</p>
            )}

            <label
              htmlFor="global-gemini-api-key"
              className="mt-5 block text-light-100"
            >
              Gemini API key
            </label>
            <Input
              id="global-gemini-api-key"
              className="mt-2 min-h-12 rounded-full bg-dark-200 px-5"
              type="password"
              autoComplete="off"
              autoFocus
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSave();
              }}
              placeholder={
                apiKey ? "Enter a replacement key" : "Enter your Gemini API key"
              }
              aria-invalid={Boolean(formError)}
              aria-describedby={formError ? "gemini-key-error" : undefined}
            />
            {formError && (
              <p id="gemini-key-error" className="mt-2" role="alert">
                {formError}
              </p>
            )}

            <div className="mt-5 flex flex-wrap gap-3">
              <Button className="btn-primary" onClick={handleSave}>
                Use key
              </Button>
              <Button className="btn-secondary" onClick={() => finishRequest()}>
                Cancel
              </Button>
              {apiKey && (
                <Button className="btn-secondary" onClick={handleRemove}>
                  Remove API key
                </Button>
              )}
            </div>
          </section>
        </div>
      )}
    </GeminiApiKeyContext.Provider>
  );
}

export function GeminiApiKeyControl() {
  const { apiKey, requestApiKey } = useGeminiApiKey();

  return (
    <Button
      type="button"
      className="btn-secondary max-w-[220px] text-xs sm:text-sm"
      onClick={() => void requestApiKey()}
      aria-label={
        apiKey ? "Change temporary Gemini API key" : "Use your Gemini API key"
      }
    >
      {apiKey ? `Gemini key: ${maskApiKey(apiKey)}` : "Use your API key"}
    </Button>
  );
}

export function useGeminiApiKey() {
  const context = useContext(GeminiApiKeyContext);
  if (!context) {
    throw new Error(
      "useGeminiApiKey must be used inside GeminiApiKeyProvider.",
    );
  }
  return context;
}
