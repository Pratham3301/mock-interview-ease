import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const kokoroMocks = vi.hoisted(() => ({
  fromPretrained: vi.fn(),
}));

import { KokoroSpeaker } from "@/lib/tts/kokoro";

const loadTtsRocks = vi.fn(async () => ({
  KokoroTTS: { from_pretrained: kokoroMocks.fromPretrained },
  detectWebGPU: vi.fn().mockResolvedValue(false),
}));

class FakeAudioContext {
  state = "running";
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
}

class FakeAudio {
  preload = "";
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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
    kokoroMocks.fromPretrained
      .mockRejectedValueOnce(new Error("temporary model download failure"))
      .mockResolvedValueOnce({ generate: vi.fn() });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    vi.stubGlobal("Audio", FakeAudio);
    const speaker = new KokoroSpeaker(loadTtsRocks);

    await expect(speaker.prepare()).rejects.toThrow(
      "temporary model download failure"
    );
    await expect(speaker.prepare()).resolves.toMatchObject({ device: "wasm" });

    expect(kokoroMocks.fromPretrained).toHaveBeenCalledTimes(2);
    await speaker.close();
  });
});
