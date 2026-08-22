import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpeechRecognizer,
  shouldFallbackToLocalSpeechRecognition,
} from "@/lib/stt";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cross-browser local speech recognition", () => {
  it("selects the worker-backed local recognizer when Web Speech is absent", () => {
    class FakeAudioContext {}
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      AudioWorkletNode: class {},
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal("Worker", class {});

    const recognizer = createSpeechRecognizer({
      onResult: vi.fn(),
      onSpeechActivity: vi.fn(),
      onError: vi.fn(),
    });

    expect(recognizer.kind).toBe("local");
  });

  it("prefers local recognition in Brave even when Web Speech is exposed", () => {
    class FakeAudioContext {}
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      AudioWorkletNode: class {},
      webkitSpeechRecognition: class {},
    });
    vi.stubGlobal("navigator", {
      brave: {},
      mediaDevices: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal("Worker", class {});

    const recognizer = createSpeechRecognizer({
      onResult: vi.fn(),
      onSpeechActivity: vi.fn(),
      onError: vi.fn(),
    });

    expect(recognizer.kind).toBe("local");
  });

  it("moves native network failures to local recognition", () => {
    class FakeAudioContext {}
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      AudioWorkletNode: class {},
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal("Worker", class {});

    expect(
      shouldFallbackToLocalSpeechRecognition(new Error("network"), "browser")
    ).toBe(true);
    expect(
      shouldFallbackToLocalSpeechRecognition(new Error("network"), "local")
    ).toBe(false);
  });

  it("keeps model inference and microphone processing off the UI thread", () => {
    const workerSource = fs.readFileSync(
      path.join(process.cwd(), "lib/stt/local.worker.ts"),
      "utf8"
    );
    const recognizerSource = fs.readFileSync(
      path.join(process.cwd(), "lib/stt/local.ts"),
      "utf8"
    );
    const worklet = path.join(
      process.cwd(),
      "public/worklets/stt-capture.js"
    );

    expect(workerSource).toContain("onnx-community/moonshine-tiny-ONNX");
    expect(workerSource).toContain(
      "/vendor/transformers/transformers-bundle.min.js"
    );
    expect(workerSource).toContain('"webgpu"');
    expect(workerSource).toContain('"wasm"');
    expect(recognizerSource).toContain("new Worker(");
    expect(fs.existsSync(worklet)).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          process.cwd(),
          "public/vendor/transformers/transformers-bundle.min.js"
        )
      )
    ).toBe(true);
  });
});
