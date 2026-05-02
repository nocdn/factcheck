import { logger } from "./logger";

export const logPreviewLimits = {
  modelResponse: 1_000,
  prompt: 400,
  reasoning: 500,
  transcript: 300,
} as const;

export function logEvent(
  requestId: string | null,
  event: string,
  payload: Record<string, unknown>,
): void {
  const child = requestId ? logger.child({ requestId }) : logger;
  child.info({ ...payload, event }, event);
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
