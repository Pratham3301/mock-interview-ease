import type {
  RecognitionResultCallback,
  RecognitionStateCallback,
  SpeechRecognizer,
} from "./types";

type LocalWorkerMessage =
  | { type: "progress"; progress: number }
  | { type: "ready"; engine: "webgpu" | "wasm" }
  | { type: "speech-start" }
  | { type: "speech-end" }
  | { type: "result"; transcript: string }
  | { type: "error"; message: string };

interface AudioContextConstructor {
  new (options?: AudioContextOptions): AudioContext;
}

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  const audioWindow = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return window.AudioContext ?? audioWindow.webkitAudioContext;
}

export class LocalSpeechRecognizer implements SpeechRecognizer {
  readonly kind = "local" as const;
  private worker?: Worker;
  private ready = false;
  private preparePromise?: Promise<void>;
  private resolvePrepare?: () => void;
  private rejectPrepare?: (error: Error) => void;
  private progressCallback?: (progress: number) => void;
  private audioContext?: AudioContext;
  private mediaStream?: MediaStream;
  private sourceNode?: MediaStreamAudioSourceNode;
  private captureNode?: AudioWorkletNode;
  private captureGeneration = 0;
  private captureActive = false;
  private captureStarting = false;

  static isSupported() {
    return Boolean(
        typeof window !== "undefined" &&
        typeof Worker !== "undefined" &&
        navigator.mediaDevices !== undefined &&
        getAudioContextConstructor() &&
        "AudioWorkletNode" in window
    );
  }

  constructor(
    private readonly onResult: RecognitionResultCallback,
    private readonly onSpeechActivity: RecognitionStateCallback,
    private readonly onError: (error: Error) => void
  ) {}

  async requestPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Browser microphone capture is unavailable.");
    }

    let permissionState: PermissionState | undefined;
    try {
      const permission = await navigator.permissions?.query({
        name: "microphone" as PermissionName,
      });
      permissionState = permission?.state;
    } catch {
      // Firefox and some embedded browsers do not expose microphone permission.
    }
    if (permissionState === "granted") return;
    if (permissionState === "denied") {
      throw new DOMException("Microphone access is denied.", "NotAllowedError");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  }

  prepare(onProgress?: (progress: number) => void) {
    this.progressCallback = onProgress;
    if (this.ready) {
      onProgress?.(100);
      return Promise.resolve();
    }
    if (this.preparePromise) return this.preparePromise;

    this.preparePromise = new Promise<void>((resolve, reject) => {
      this.resolvePrepare = resolve;
      this.rejectPrepare = reject;
      try {
        this.worker = new Worker(new URL("./local.worker.ts", import.meta.url), {
          type: "module",
          name: "prepwise-local-stt",
        });
        this.worker.onmessage = (event: MessageEvent<LocalWorkerMessage>) =>
          this.handleWorkerMessage(event.data);
        this.worker.onerror = (event) => {
          const error = new Error(event.message || "Local speech worker failed.");
          const wasPreparing = Boolean(this.rejectPrepare);
          this.failPreparation(error);
          if (!wasPreparing) this.onError(error);
        };
        this.worker.postMessage({ type: "init" });
      } catch (error) {
        this.failPreparation(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    return this.preparePromise;
  }

  start() {
    if (this.captureActive || this.captureStarting) return;
    void this.startCapture().catch((error) => {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  stop() {
    this.worker?.postMessage({ type: "reset" });
    void this.stopCapture();
  }

  abort() {
    const rejectPreparation = this.rejectPrepare;
    this.captureGeneration += 1;
    this.captureStarting = false;
    void this.stopCapture();
    this.worker?.postMessage({ type: "dispose" });
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = false;
    this.preparePromise = undefined;
    this.resolvePrepare = undefined;
    this.rejectPrepare = undefined;
    this.progressCallback = undefined;
    rejectPreparation?.(new Error("Local speech recognition was cancelled."));
  }

  private async startCapture() {
    if (!this.ready || !this.worker) {
      throw new Error("Local speech recognition is not prepared.");
    }
    if (this.captureActive || this.captureStarting) return;
    this.captureStarting = true;

    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass) {
      throw new Error("Web Audio is unavailable in this browser.");
    }

    const generation = ++this.captureGeneration;
    const stream = await navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      .catch((error) => {
        this.captureStarting = false;
        throw error;
      });
    if (generation !== this.captureGeneration) {
      this.captureStarting = false;
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    let audioContext: AudioContext;
    try {
      try {
        audioContext = new AudioContextClass({
          sampleRate: 16_000,
          latencyHint: "interactive",
        });
      } catch {
        audioContext = new AudioContextClass({ latencyHint: "interactive" });
      }
    } catch (error) {
      this.captureStarting = false;
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }

    try {
      await audioContext.audioWorklet.addModule("/worklets/stt-capture.js");
      if (generation !== this.captureGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        await audioContext.close();
        return;
      }

      const source = audioContext.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(
        audioContext,
        "prepwise-stt-capture"
      );
      capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.captureActive || !this.worker) return;
        const samples = event.data;
        this.worker.postMessage(
          { type: "audio", samples, sampleRate: audioContext.sampleRate },
          [samples.buffer]
        );
      };
      source.connect(capture);
      capture.connect(audioContext.destination);

      this.mediaStream = stream;
      this.audioContext = audioContext;
      this.sourceNode = source;
      this.captureNode = capture;
      this.captureActive = true;
      this.captureStarting = false;
      this.worker.postMessage({ type: "reset" });
      await audioContext.resume();
    } catch (error) {
      this.captureStarting = false;
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close().catch(() => undefined);
      throw error;
    }
  }

  private async stopCapture() {
    this.captureGeneration += 1;
    this.captureActive = false;
    this.captureStarting = false;
    this.onSpeechActivity(false);

    const capture = this.captureNode;
    const source = this.sourceNode;
    const stream = this.mediaStream;
    const context = this.audioContext;
    this.captureNode = undefined;
    this.sourceNode = undefined;
    this.mediaStream = undefined;
    this.audioContext = undefined;

    if (capture) {
      capture.port.onmessage = null;
      capture.disconnect();
    }
    source?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }

  private handleWorkerMessage(message: LocalWorkerMessage) {
    switch (message.type) {
      case "progress":
        this.progressCallback?.(message.progress);
        break;
      case "ready":
        this.ready = true;
        this.progressCallback?.(100);
        this.resolvePrepare?.();
        this.resolvePrepare = undefined;
        this.rejectPrepare = undefined;
        break;
      case "speech-start":
        this.onSpeechActivity(true);
        break;
      case "speech-end":
        this.onSpeechActivity(false);
        // Inference continues in the worker; releasing capture avoids wasting CPU.
        void this.stopCapture();
        break;
      case "result":
        if (message.transcript) this.onResult(message.transcript);
        else this.onError(new Error("No speech was recognized."));
        break;
      case "error": {
        const error = new Error(message.message);
        const wasPreparing = Boolean(this.rejectPrepare);
        this.failPreparation(error);
        void this.stopCapture();
        if (!wasPreparing) this.onError(error);
        break;
      }
    }
  }

  private failPreparation(error: Error) {
    this.rejectPrepare?.(error);
    this.resolvePrepare = undefined;
    this.rejectPrepare = undefined;
    this.preparePromise = undefined;
  }
}
