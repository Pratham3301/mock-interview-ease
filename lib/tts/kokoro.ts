const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_VOICE = "af_heart";
const TTS_ROCKS_BUNDLE_URL = "/vendor/tts-rocks/kokoro-bundle.es.js";
const TTS_ROCKS_ORT_MODULE_URL =
  "/vendor/tts-rocks/ort-wasm-simd-threaded.jsep.mjs";
const TTS_ROCKS_ORT_WASM_URL =
  "/vendor/tts-rocks/kokoro-ort-wasm-simd-threaded.jsep.wasm";

type KokoroDevice = "webgpu" | "wasm";

interface TtsRocksAudio {
  toBlob(): Blob;
}

interface TtsRocksKokoroInstance {
  generate(
    text: string,
    options: { voice: string; speed: number }
  ): Promise<TtsRocksAudio>;
}

interface TtsRocksModule {
  KokoroTTS: {
    from_pretrained(
      model: string,
      options: {
        dtype: "fp32" | "q8";
        device: KokoroDevice;
        progress_callback?: (progress: unknown) => void;
      }
    ): Promise<TtsRocksKokoroInstance>;
  };
  detectWebGPU(): Promise<boolean>;
  env: {
    backends: {
      onnx?: {
        logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
        wasm?: {
          wasmPaths?:
            | string
            | {
                mjs: string;
                wasm: string;
              };
          proxy?: boolean;
          numThreads?: number;
        };
      };
    };
  };
}

type TtsRocksModuleLoader = () => Promise<TtsRocksModule>;

interface LoadedKokoroModel {
  instance: TtsRocksKokoroInstance;
  device: KokoroDevice;
}

let sharedModel: Promise<LoadedKokoroModel> | undefined;
let sharedModelReady = false;
let sharedProgress = 0;
const progressListeners = new Set<(progress: number) => void>();

function emitSharedProgress(progress: number) {
  sharedProgress = Math.max(0, Math.min(100, progress));
  progressListeners.forEach((listener) => listener(sharedProgress));
}

async function loadTtsRocksModule(): Promise<TtsRocksModule> {
  // tts.rocks ships this as a complete browser ESM bundle. Loading it as a
  // public asset keeps Next/Webpack from rewriting its ONNX runtime internals.
  return import(
    /* webpackIgnore: true */ TTS_ROCKS_BUNDLE_URL
  ) as Promise<TtsRocksModule>;
}

function progressReporter(onProgress?: (progress: number) => void) {
  let previousProgress = -1;
  return (progress: unknown) => {
    if (
      !progress ||
      typeof progress !== "object" ||
      !("progress" in progress) ||
      typeof progress.progress !== "number"
    ) {
      return;
    }
    const nextProgress = Math.round(
      Math.max(0, Math.min(100, progress.progress))
    );
    if (nextProgress === previousProgress) return;
    previousProgress = nextProgress;
    onProgress?.(nextProgress);
  };
}

async function loadModel(
  bundle: TtsRocksModule,
  device: KokoroDevice,
  onProgress?: (progress: number) => void
): Promise<LoadedKokoroModel> {
  const instance = await bundle.KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: device === "webgpu" ? "fp32" : "q8",
    device,
    progress_callback: progressReporter(onProgress),
  });
  return { instance, device };
}

async function loadPreferredModel(
  loader: TtsRocksModuleLoader,
  onProgress?: (progress: number) => void
) {
  const bundle = await loader();
  const onnxEnvironment = bundle.env.backends.onnx;
  if (onnxEnvironment) {
    // The tts.rocks bundle defaults to jsDelivr. Keep its matching ONNX
    // runtime local and silence benign WebGPU node-assignment warnings while
    // retaining errors that affect playback.
    onnxEnvironment.logLevel = "error";
    if (onnxEnvironment.wasm) {
      onnxEnvironment.wasm.wasmPaths = {
        mjs: TTS_ROCKS_ORT_MODULE_URL,
        wasm: TTS_ROCKS_ORT_WASM_URL,
      };
      onnxEnvironment.wasm.proxy = false;
      onnxEnvironment.wasm.numThreads = 1;
    }
  }
  if (await bundle.detectWebGPU()) {
    try {
      return await loadModel(bundle, "webgpu", onProgress);
    } catch {
      // Some browsers expose WebGPU while their adapter cannot run this model.
    }
  }
  return loadModel(bundle, "wasm", onProgress);
}

function getSharedModel(
  loader: TtsRocksModuleLoader,
  onProgress?: (progress: number) => void
) {
  if (onProgress) {
    progressListeners.add(onProgress);
    onProgress(sharedModelReady ? 100 : sharedProgress);
  }
  if (!sharedModel) {
    sharedProgress = 0;
    sharedModelReady = false;
    sharedModel = loadPreferredModel(loader, emitSharedProgress)
      .then((model) => {
        sharedModelReady = true;
        emitSharedProgress(100);
        return model;
      })
      .catch((error) => {
        // A rejected shared promise makes every Retry fail immediately. Clear it
        // so a transient download/backend failure can be attempted again.
        sharedModel = undefined;
        sharedModelReady = false;
        sharedProgress = 0;
        throw error;
      });
  }
  return sharedModel.finally(() => {
    if (onProgress) progressListeners.delete(onProgress);
  });
}

export class KokoroSpeaker {
  private context?: AudioContext;
  private audio?: HTMLAudioElement;
  private objectUrl?: string;
  private finishPlayback?: () => void;
  private generation = 0;

  constructor(
    private readonly moduleLoader: TtsRocksModuleLoader = loadTtsRocksModule
  ) {}

  async prepare(onProgress?: (progress: number) => void) {
    if (!this.context) this.context = new window.AudioContext();
    await this.context.resume();
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
    }
    return getSharedModel(this.moduleLoader, onProgress);
  }

  async speak(
    text: string,
    options: {
      onProgress?: (progress: number) => void;
      onPlaybackStart?: () => void;
    } = {}
  ) {
    this.stop();
    const generation = this.generation;
    const { instance } = await this.prepare(options.onProgress);

    let rawAudio: TtsRocksAudio;
    try {
      rawAudio = await instance.generate(text, {
        voice: KOKORO_VOICE,
        speed: 1,
      });
    } catch (error) {
      sharedModel = undefined;
      throw error;
    }
    if (generation !== this.generation) return;

    const audio = this.audio!;
    const objectUrl = URL.createObjectURL(rawAudio.toBlob());
    this.objectUrl = objectUrl;
    audio.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (this.finishPlayback === cancel) this.finishPlayback = undefined;
        audio.onended = null;
        audio.onerror = null;
        this.releaseObjectUrl(objectUrl);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish();
      this.finishPlayback = cancel;
      audio.onended = () => finish();
      audio.onerror = () =>
        finish(new Error("The browser could not play the generated audio."));

      audio
        .play()
        .then(() => {
          if (!settled && generation === this.generation) {
            options.onPlaybackStart?.();
          }
        })
        .catch((error) => finish(error));
    });
  }

  stop() {
    this.generation += 1;
    this.finishPlayback?.();
    this.finishPlayback = undefined;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
    this.releaseObjectUrl();
  }

  async close() {
    this.stop();
    this.audio = undefined;
    if (this.context && this.context.state !== "closed") {
      await this.context.close();
    }
    this.context = undefined;
  }

  private releaseObjectUrl(url = this.objectUrl) {
    if (!url) return;
    URL.revokeObjectURL(url);
    if (this.objectUrl === url) this.objectUrl = undefined;
  }
}
