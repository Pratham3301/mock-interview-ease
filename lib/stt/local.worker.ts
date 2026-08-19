const MODEL_ID = "onnx-community/moonshine-tiny-ONNX";
const TRANSFORMERS_BUNDLE_URL =
  "/vendor/transformers/transformers-bundle.min.js";
const ORT_WASM_URL =
  "/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm";
const ORT_WASM_MODULE_URL =
  "/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs";
const TARGET_SAMPLE_RATE = 16_000;
const SPEECH_THRESHOLD = 0.012;
const SILENCE_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.85);
const PRE_ROLL_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.3);
const MIN_SPEECH_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.25);

type Engine = "webgpu" | "wasm";
type WorkerInput =
  | { type: "init" }
  | { type: "audio"; samples: Float32Array; sampleRate: number }
  | { type: "reset" }
  | { type: "dispose" };

interface ProgressInfo {
  status: string;
  progress?: number;
}

interface SpeechRecognitionOutput {
  text: string;
}

interface LocalTranscriber {
  (audio: Float32Array): Promise<
    SpeechRecognitionOutput | SpeechRecognitionOutput[]
  >;
  dispose(): Promise<void> | void;
}

interface TransformersBrowserModule {
  env: {
    backends: {
      onnx: {
        wasm?: {
          numThreads?: number;
          wasmPaths?: { wasm: string; mjs: string };
        };
      };
    };
  };
  pipeline(
    task: "automatic-speech-recognition",
    model: string,
    options: {
      device: Engine;
      dtype: Record<string, string>;
      progress_callback: (info: ProgressInfo) => void;
    }
  ): Promise<LocalTranscriber>;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerInput>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};

let transformersModule: Promise<TransformersBrowserModule> | undefined;
let transcriber: LocalTranscriber | undefined;
let initializing: Promise<void> | undefined;
let recording = false;
let transcribing = false;
let speechSamples = 0;
let silentSamples = 0;
let speechChunks: Float32Array[] = [];
let preRoll: Float32Array[] = [];
let preRollLength = 0;

function post(message: unknown) {
  workerScope.postMessage(message);
}

async function getTransformersModule() {
  if (!transformersModule) {
    transformersModule = import(
      /* webpackIgnore: true */ TRANSFORMERS_BUNDLE_URL
    ) as Promise<TransformersBrowserModule>;
  }
  const library = await transformersModule;
  if (library.env.backends.onnx.wasm) {
    // Inference already runs in this dedicated worker. Avoid a large WASM
    // thread pool that can saturate the tab and make React unresponsive.
    library.env.backends.onnx.wasm.numThreads = 1;
    library.env.backends.onnx.wasm.wasmPaths = {
      wasm: ORT_WASM_URL,
      mjs: ORT_WASM_MODULE_URL,
    };
  }
  return library;
}

async function supportsWebGpu() {
  const gpu = (
    navigator as unknown as {
      gpu?: { requestAdapter(): Promise<unknown | null> };
    }
  ).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function loadPipeline(engine: Engine) {
  const transformers = await getTransformersModule();
  let lastProgress = 0;
  const progressCallback = (info: ProgressInfo) => {
    if (info.status !== "progress_total" || info.progress === undefined) return;
    const progress = Math.max(lastProgress, Math.min(99, info.progress));
    if (progress - lastProgress < 0.5) return;
    lastProgress = progress;
    post({ type: "progress", progress });
  };

  return transformers.pipeline("automatic-speech-recognition", MODEL_ID, {
    device: engine,
    dtype: {
      encoder_model: "fp32",
      decoder_model_merged: "q4",
    },
    progress_callback: progressCallback,
  });
}

async function initialize() {
  if (transcriber) return;
  if (initializing) return initializing;

  initializing = (async () => {
    let engine: Engine = (await supportsWebGpu()) ? "webgpu" : "wasm";
    try {
      transcriber = await loadPipeline(engine);
    } catch (webGpuError) {
      if (engine !== "webgpu") throw webGpuError;
      engine = "wasm";
      post({ type: "progress", progress: 0 });
      transcriber = await loadPipeline(engine);
    }
    post({ type: "ready", engine });
  })()
    .catch((error) => {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      initializing = undefined;
    });

  return initializing;
}

function resetAudio() {
  recording = false;
  transcribing = false;
  speechSamples = 0;
  silentSamples = 0;
  speechChunks = [];
  preRoll = [];
  preRollLength = 0;
}

function resample(input: Float32Array, sourceRate: number) {
  if (sourceRate === TARGET_SAMPLE_RATE) return input;
  const outputLength = Math.max(
    1,
    Math.round((input.length * TARGET_SAMPLE_RATE) / sourceRate)
  );
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] =
      input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function rms(samples: Float32Array) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function addPreRoll(samples: Float32Array) {
  preRoll.push(samples);
  preRollLength += samples.length;
  while (preRollLength > PRE_ROLL_SAMPLES && preRoll.length > 1) {
    preRollLength -= preRoll[0].length;
    preRoll.shift();
  }
}

function combine(chunks: Float32Array[], length: number) {
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function finalizeSpeech() {
  if (transcribing || !transcriber) return;
  const chunks = speechChunks;
  const length = speechSamples;
  recording = false;
  transcribing = true;
  speechChunks = [];
  speechSamples = 0;
  silentSamples = 0;
  preRoll = [];
  preRollLength = 0;

  if (length < MIN_SPEECH_SAMPLES) {
    transcribing = false;
    return;
  }

  post({ type: "speech-end" });
  try {
    const output = await transcriber(combine(chunks, length));
    const transcript = Array.isArray(output)
      ? output.map((item) => item.text).join(" ").trim()
      : output.text.trim();
    post({ type: "result", transcript });
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    transcribing = false;
  }
}

function receiveAudio(input: Float32Array, sampleRate: number) {
  if (!transcriber || transcribing || !input.length) return;
  const samples = resample(input, sampleRate);
  const isSpeech = rms(samples) >= SPEECH_THRESHOLD;

  if (!recording) {
    addPreRoll(samples);
    if (!isSpeech) return;
    recording = true;
    speechChunks = [...preRoll];
    speechSamples = preRollLength;
    preRoll = [];
    preRollLength = 0;
    post({ type: "speech-start" });
  } else {
    speechChunks.push(samples);
    speechSamples += samples.length;
  }

  if (isSpeech) {
    silentSamples = 0;
  } else {
    silentSamples += samples.length;
    if (silentSamples >= SILENCE_SAMPLES) void finalizeSpeech();
  }
}

workerScope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      void initialize().catch(() => undefined);
      break;
    case "audio":
      receiveAudio(message.samples, message.sampleRate);
      break;
    case "reset":
      resetAudio();
      break;
    case "dispose":
      resetAudio();
      void transcriber?.dispose();
      transcriber = undefined;
      workerScope.close();
      break;
  }
};
