export function feedbackDocumentId(userId: string, interviewId: string) {
  return `${userId}_${interviewId}`.replaceAll("/", "_");
}
