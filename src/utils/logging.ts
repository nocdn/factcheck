import { logger } from "./logger";

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
