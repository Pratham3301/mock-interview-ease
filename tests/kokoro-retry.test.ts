import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const kokoroMocks = vi.hoisted(() => ({
  fromPretrained: vi.fn(),
  onnxEnvironment: {
    logLevel: "warning" as const,
    wasm: {
      wasmPaths:
        "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/" as
          | string
          | { mjs: string; wasm: string },
      proxy: true,
      numThreads: 4,
    },
  },
}));

import { KokoroSpeaker } from "@/lib/tts/kokoro";

const loadTtsRocks = vi.fn(async () => ({
  KokoroTTS: { from_pretrained: kokoroMocks.fromPretrained },
  detectWebGPU: vi.fn().mockResolvedValue(false),
  env: { backends: { onnx: kokoroMocks.onnxEnvironment } },
}));

class FakeAudioContext {
  state = "running";
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
}

class FakeAudio {
  static latest?: FakeAudio;
  preload = "";
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();

  constructor() {
    FakeAudio.latest = this;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  FakeAudio.latest = undefined;
  kokoroMocks.onnxEnvironment.logLevel = "warning";
  kokoroMocks.onnxEnvironment.wasm.wasmPaths =
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/";
  kokoroMocks.onnxEnvironment.wasm.proxy = true;
  kokoroMocks.onnxEnvironment.wasm.numThreads = 4;
});

describe("tts.rocks Kokoro initialization retry", () => {
  it("uses the vendored tts.rocks browser distribution", () => {
    const speakerSource = fs.readFileSync(
      path.join(process.cwd(), "lib/tts/kokoro.ts"),
      "utf8"
    );
    const vendorDirectory = path.join(
      process.cwd(),
      "public/vendor/tts-rocks"
    );

    expect(speakerSource).toContain(
      "/vendor/tts-rocks/kokoro-bundle.es.js"
    );
    expect(
      fs.existsSync(path.join(vendorDirectory, "kokoro-bundle.es.js"))
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          vendorDirectory,
          "kokoro-ort-wasm-simd-threaded.jsep.wasm"
        )
      )
    ).toBe(true);

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies).not.toHaveProperty("kokoro-js");
  });

  it("clears a rejected shared model promise so Retry can initialize again", async () => {
    let resolveGeneratedAudio: ((audio: { toBlob(): Blob }) => void) | undefined;
    const generate = vi.fn(
      () =>
        new Promise<{ toBlob(): Blob }>((resolve) => {
          resolveGeneratedAudio = resolve;
        })
    );
    kokoroMocks.fromPretrained
      .mockRejectedValueOnce(new Error("temporary model download failure"))
      .mockImplementationOnce(async (_model, options) => {
        options.progress_callback?.({ progress: 37 });
        return { generate };
      });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:voice"),
      revokeObjectURL: vi.fn(),
    });
    const speaker = new KokoroSpeaker(loadTtsRocks);
    const progress = vi.fn();

    await expect(speaker.prepare()).rejects.toThrow(
      "temporary model download failure"
    );
    await expect(speaker.prepare(progress)).resolves.toMatchObject({
      device: "wasm",
    });

    expect(kokoroMocks.fromPretrained).toHaveBeenCalledTimes(2);
    expect(kokoroMocks.onnxEnvironment).toMatchObject({
      logLevel: "error",
      wasm: {
        wasmPaths: {
          mjs: "/vendor/tts-rocks/ort-wasm-simd-threaded.jsep.mjs",
          wasm: "/vendor/tts-rocks/kokoro-ort-wasm-simd-threaded.jsep.wasm",
        },
        proxy: false,
        numThreads: 1,
      },
    });
    expect(progress).toHaveBeenCalledWith(37);
    expect(progress).toHaveBeenLastCalledWith(100);

    const onPlaybackStart = vi.fn();
    const playback = speaker.speak("Welcome", { onPlaybackStart });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(onPlaybackStart).not.toHaveBeenCalled();

    resolveGeneratedAudio?.({ toBlob: () => new Blob(["voice"]) });
    await vi.waitFor(() => expect(FakeAudio.latest?.play).toHaveBeenCalled());
    expect(onPlaybackStart).toHaveBeenCalledOnce();
    FakeAudio.latest?.onended?.();
    await playback;

    await speaker.close();
  });
});
