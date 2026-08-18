type RecognitionResultCallback = (transcript: string) => void;
type RecognitionStateCallback = (speaking: boolean) => void;

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getConstructor(): SpeechRecognitionConstructor | undefined {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export class BrowserSpeechRecognizer {
  private recognition?: SpeechRecognitionLike;
  private active = false;
  private restarting = false;
  private generation = 0;
  private transientFailures = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;

  static isSupported() {
    return typeof window !== "undefined" && Boolean(getConstructor());
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
      // The Permissions API does not expose microphone state in every browser.
    }
    if (permissionState === "granted") return;
    if (permissionState === "denied") {
      throw new DOMException("Microphone access is denied.", "NotAllowedError");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  }

  start() {
    if (this.active) return;
    this.transientFailures = 0;
    this.beginRecognition();
  }

  private beginRecognition() {
    const Constructor = getConstructor();
    if (!Constructor) {
      throw new Error("Browser speech recognition is unavailable.");
    }

    this.active = true;
    const generation = ++this.generation;
    const recognition = new Constructor();
    this.recognition = recognition;
    const isCurrent = () =>
      this.active &&
      this.generation === generation &&
      this.recognition === recognition;

    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onspeechstart = () => {
      if (isCurrent()) {
        this.transientFailures = 0;
        this.onSpeechActivity(true);
      }
    };
    recognition.onspeechend = () => {
      if (isCurrent()) this.onSpeechActivity(false);
    };
    recognition.onresult = (event) => {
      if (!isCurrent()) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) {
          const transcript = result[0]?.transcript?.trim();
          if (transcript) {
            this.transientFailures = 0;
            this.onResult(transcript);
          }
          if (!isCurrent()) break;
        }
      }
    };
    recognition.onerror = (event) => {
      if (!isCurrent()) return;
      if (event.error === "aborted" || event.error === "no-speech") return;
      if (event.error === "network" && this.transientFailures < 2) {
        this.scheduleTransientRestart(recognition);
        return;
      }
      this.active = false;
      this.recognition = undefined;
      this.generation += 1;
      this.detach(recognition);
      this.onError(new Error(event.message || event.error));
    };
    recognition.onend = () => {
      if (!isCurrent() || this.restarting) return;
      this.restarting = true;
      window.setTimeout(() => {
        this.restarting = false;
        if (!isCurrent()) return;
        try {
          recognition.start();
        } catch {
          // A concurrent stop can race the browser's end event.
        }
      }, 250);
    };
    try {
      recognition.start();
    } catch (error) {
      this.active = false;
      this.recognition = undefined;
      this.generation += 1;
      this.detach(recognition);
      throw error;
    }
  }

  stop() {
    this.finish("stop");
  }

  abort() {
    this.finish("abort");
  }

  private finish(method: "stop" | "abort") {
    this.active = false;
    this.restarting = false;
    this.transientFailures = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.generation += 1;
    const recognition = this.recognition;
    this.recognition = undefined;
    if (!recognition) {
      this.onSpeechActivity(false);
      return;
    }
    this.detach(recognition);
    try {
      recognition[method]();
    } catch {
      // Recognition may already be stopped.
    }
    this.onSpeechActivity(false);
  }

  private scheduleTransientRestart(recognition: SpeechRecognitionLike) {
    this.active = false;
    this.recognition = undefined;
    this.detach(recognition);
    const retryGeneration = ++this.generation;
    const delay = 250 * 2 ** this.transientFailures;
    this.transientFailures += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.generation !== retryGeneration || this.active) return;
      try {
        this.beginRecognition();
      } catch (error) {
        this.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }, delay);
  }

  private detach(recognition: SpeechRecognitionLike) {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.onspeechstart = null;
    recognition.onspeechend = null;
  }
}
