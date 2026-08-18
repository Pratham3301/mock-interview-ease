type AudioChunkCallback = (base64Pcm: string, sampleRate: number) => void;
type SpeechActivityCallback = (speaking: boolean) => void;

function audioContextConstructor() {
  return window.AudioContext;
}

function floatToPcm16(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function resample(input: Float32Array, inputRate: number, outputRate: number) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const sourcePosition = index * ratio;
    const lower = Math.floor(sourcePosition);
    const upper = Math.min(lower + 1, input.length - 1);
    const mix = sourcePosition - lower;
    output[index] = input[lower] * (1 - mix) + input[upper] * mix;
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToPcm16(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const view = new DataView(bytes.buffer);
  const output = new Float32Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return output;
}

export class PcmMicrophone {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private silentGain?: GainNode;
  private speaking = false;
  private quietTimer?: number;

  constructor(
    private readonly onChunk: AudioChunkCallback,
    private readonly onSpeechActivity: SpeechActivityCallback
  ) {}

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Browser microphone capture is unavailable.");
    }
    if (this.stream) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.context = new (audioContextConstructor())();
    await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(samples);
      const rms = Math.sqrt(
        copy.reduce((sum, sample) => sum + sample * sample, 0) / copy.length
      );
      this.updateSpeechActivity(rms > 0.025);
      const at16Khz = resample(copy, this.context!.sampleRate, 16_000);
      const pcm = floatToPcm16(at16Khz);
      this.onChunk(
        bytesToBase64(new Uint8Array(pcm.buffer)),
        16_000
      );
    };

    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
  }

  async stop() {
    if (this.quietTimer) window.clearTimeout(this.quietTimer);
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") {
      await this.context.close();
    }
    this.context = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.processor = undefined;
    this.silentGain = undefined;
    this.speaking = false;
  }

  private updateSpeechActivity(active: boolean) {
    if (active) {
      if (this.quietTimer) window.clearTimeout(this.quietTimer);
      if (!this.speaking) {
        this.speaking = true;
        this.onSpeechActivity(true);
      }
      return;
    }

    if (!this.speaking || this.quietTimer) return;
    this.quietTimer = window.setTimeout(() => {
      this.quietTimer = undefined;
      this.speaking = false;
      this.onSpeechActivity(false);
    }, 350);
  }
}

export class PcmAudioPlayer {
  private context?: AudioContext;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private idleResolvers = new Set<() => void>();

  constructor(private readonly onActivity: SpeechActivityCallback) {}

  async prepare() {
    if (!this.context) this.context = new (audioContextConstructor())();
    await this.context.resume();
  }

  async play(base64Pcm: string, sampleRate = 24_000) {
    await this.prepare();
    const context = this.context!;
    const samples = base64ToPcm16(base64Pcm);
    if (!samples.length) return;

    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const generation = this.generation;
    const startAt = Math.max(context.currentTime + 0.01, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.add(source);
    this.onActivity(true);
    source.onended = () => {
      this.sources.delete(source);
      if (generation === this.generation && this.sources.size === 0) {
        this.nextStartTime = context.currentTime;
        this.onActivity(false);
        this.resolveIdle();
      }
    };
    source.start(startAt);
  }

  interrupt() {
    this.generation += 1;
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
    });
    this.sources.clear();
    if (this.context) this.nextStartTime = this.context.currentTime;
    this.onActivity(false);
    this.resolveIdle();
  }

  waitForIdle() {
    if (this.sources.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleResolvers.add(resolve));
  }

  async close() {
    this.interrupt();
    if (this.context && this.context.state !== "closed") {
      await this.context.close();
    }
    this.context = undefined;
  }

  private resolveIdle() {
    this.idleResolvers.forEach((resolve) => resolve());
    this.idleResolvers.clear();
  }
}
