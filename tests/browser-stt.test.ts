import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserSpeechRecognizer } from "@/lib/stt/browser";

class FakeRecognition {
  static latest?: FakeRecognition;
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  lang = "";
  onresult: ((event: never) => void) | null = null;
  onerror: ((event: { error: string; message?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeRecognition.latest = this;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeRecognition.latest = undefined;
});

describe("browser speech recognition lifecycle", () => {
  it("uses final-only continuous recognition to reduce main-thread event churn", () => {
    vi.stubGlobal("window", {
      SpeechRecognition: FakeRecognition,
      setTimeout,
    });
    const recognizer = new BrowserSpeechRecognizer(vi.fn(), vi.fn(), vi.fn());

    recognizer.start();

    expect(FakeRecognition.latest).toMatchObject({
      continuous: true,
      interimResults: false,
      maxAlternatives: 1,
    });
  });

  it("ignores late errors from a recognizer that was aborted during cleanup", () => {
    vi.stubGlobal("window", {
      SpeechRecognition: FakeRecognition,
      setTimeout,
    });
    const onError = vi.fn();
    const recognizer = new BrowserSpeechRecognizer(vi.fn(), vi.fn(), onError);

    recognizer.start();
    const staleErrorHandler = FakeRecognition.latest!.onerror!;
    recognizer.abort();
    staleErrorHandler({ error: "network", message: "late browser event" });

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not reacquire and immediately release the microphone when permission is already granted", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      mediaDevices: { getUserMedia },
    });
    const recognizer = new BrowserSpeechRecognizer(vi.fn(), vi.fn(), vi.fn());

    await recognizer.requestPermission();

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("retries transient recognizer network failures before surfacing an error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      SpeechRecognition: FakeRecognition,
      setTimeout,
    });
    const onError = vi.fn();
    const recognizer = new BrowserSpeechRecognizer(vi.fn(), vi.fn(), onError);

    recognizer.start();
    FakeRecognition.latest!.onerror!({ error: "network" });
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    FakeRecognition.latest!.onerror!({ error: "network" });
    await vi.advanceTimersByTimeAsync(500);
    FakeRecognition.latest!.onerror!({ error: "network" });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(new Error("network"));
  });
});
