import type { TranscriptMessage, VoiceSessionConfig } from "@/lib/voice/types";

export const INTERVIEW_REQUIREMENTS_TOOL = "submitInterviewRequirements";

export const interviewCreationInstruction = `You are helping the user create a mock interview.

Collect the following information conversationally, asking for one missing item at a time:
- target job role
- experience level
- technology stack
- interview type or focus: technical, behavioral, or mixed
- number of questions

Do not generate interview questions during this conversation. Briefly confirm the complete preferences. Once every field is present and confirmed, call submitInterviewRequirements exactly once. Do not call it again after it succeeds.`;

export function mockInterviewInstruction(
  userName: string,
  questions: string[]
) {
  return `You are conducting a professional mock interview.

Candidate: ${userName}

Interview questions:
${questions.map((question) => `- ${question}`).join("\n")}

Rules:
- Ask one primary interview question at a time.
- Follow the provided question list in order unless conversational context requires a minor adjustment.
- Let the candidate complete their answer.
- Briefly acknowledge answers.
- Ask concise follow-up questions only when useful.
- Do not reveal ideal or model answers during the interview.
- Do not score the candidate during the interview.
- Keep responses professional and concise.
- Do not dominate the conversation.
- Complete the supplied interview.
- When every supplied question is complete, call completeInterview exactly once, then conclude politely.`;
}

export function getVoiceSystemInstruction(config: VoiceSessionConfig) {
  return config.kind === "generate"
    ? interviewCreationInstruction
    : mockInterviewInstruction(config.userName, config.questions ?? []);
}

export function formatConversationHistory(transcript: TranscriptMessage[]) {
  if (!transcript.length) return "No previous conversation turns.";

  return transcript
    .filter((message) => message.final)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}
