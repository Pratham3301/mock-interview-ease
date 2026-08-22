import { BrowserSpeechRecognizer } from "./browser";
import { LocalSpeechRecognizer } from "./local";
import type {
  RecognitionResultCallback,
  RecognitionStateCallback,
  SpeechRecognizer,
} from "./types";

export interface SpeechRecognizerCallbacks {
  onResult: RecognitionResultCallback;
  onSpeechActivity: RecognitionStateCallback;
  onError: (error: Error) => void;
}

type SpeechRecognitionPreference = "auto" | "browser" | "local";

function preference(): SpeechRecognitionPreference {
  const configured = process.env.NEXT_PUBLIC_FALLBACK_STT_MODE;
  return configured === "browser" || configured === "local"
    ? configured
    : "auto";
}

function isBraveBrowser() {
  return typeof navigator !== "undefined" && "brave" in navigator;
}

export function isLocalSpeechRecognitionSupported() {
  return LocalSpeechRecognizer.isSupported();
}

export function isSpeechRecognitionSupported() {
  const selected = preference();
  if (selected === "browser") return BrowserSpeechRecognizer.isSupported();
  if (selected === "local") return LocalSpeechRecognizer.isSupported();
  return (
    BrowserSpeechRecognizer.isSupported() || LocalSpeechRecognizer.isSupported()
  );
}

export function createSpeechRecognizer({
  onResult,
  onSpeechActivity,
  onError,
}: SpeechRecognizerCallbacks): SpeechRecognizer {
  const selected = preference();

  if (
    selected === "auto" &&
    isBraveBrowser() &&
    LocalSpeechRecognizer.isSupported()
  ) {
    return new LocalSpeechRecognizer(onResult, onSpeechActivity, onError);
  }

  if (selected !== "local" && BrowserSpeechRecognizer.isSupported()) {
    return new BrowserSpeechRecognizer(onResult, onSpeechActivity, onError);
  }

  if (selected !== "browser" && LocalSpeechRecognizer.isSupported()) {
    return new LocalSpeechRecognizer(onResult, onSpeechActivity, onError);
  }

  throw new Error(
    selected === "local"
      ? "Local speech recognition is unavailable in this browser."
      : "Speech recognition is unavailable in this browser."
  );
}

export function createLocalSpeechRecognizer({
  onResult,
  onSpeechActivity,
  onError,
}: SpeechRecognizerCallbacks): SpeechRecognizer {
  if (!LocalSpeechRecognizer.isSupported()) {
    throw new Error("Local speech recognition is unavailable in this browser.");
  }
  return new LocalSpeechRecognizer(onResult, onSpeechActivity, onError);
}

export function shouldFallbackToLocalSpeechRecognition(
  error: Error,
  currentKind: SpeechRecognizer["kind"]
) {
  if (
    preference() === "browser" ||
    currentKind !== "browser" ||
    !LocalSpeechRecognizer.isSupported()
  ) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("network") ||
    message.includes("service-not-allowed") ||
    message.includes("language-not-supported")
  );
}

export type { SpeechRecognizer } from "./types";
