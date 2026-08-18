import type { TranscriptMessage } from "./types";

const TRANSCRIPT_PREFIX = "prepwise:interview-transcript:";

export function transcriptStorageKey(interviewId: string) {
  return `${TRANSCRIPT_PREFIX}${interviewId}`;
}

export class TranscriptBuffer {
  private messages: TranscriptMessage[];

  constructor(initial: TranscriptMessage[] = []) {
    this.messages = initial.filter((message) => message.final);
  }

  append(message: TranscriptMessage) {
    if (!message.final || !message.content.trim()) return;
    this.messages.push({ ...message, content: message.content.trim() });
  }

  snapshot() {
    return this.messages.map((message) => ({ ...message }));
  }
}

export function readStoredTranscript(
  storage: Pick<Storage, "getItem">,
  interviewId: string
): TranscriptMessage[] {
  try {
    const value = storage.getItem(transcriptStorageKey(interviewId));
    if (!value) return [];
    const parsed = JSON.parse(value) as TranscriptMessage[];
    return parsed.filter(
      (message) =>
        message.final &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
    );
  } catch {
    return [];
  }
}

export function storeTranscript(
  storage: Pick<Storage, "setItem">,
  interviewId: string,
  transcript: TranscriptMessage[]
) {
  storage.setItem(
    transcriptStorageKey(interviewId),
    JSON.stringify(transcript.filter((message) => message.final))
  );
}

export function clearStoredTranscript(
  storage: Pick<Storage, "removeItem">,
  interviewId: string
) {
  storage.removeItem(transcriptStorageKey(interviewId));
}
