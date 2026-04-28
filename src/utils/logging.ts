export function logEvent(
  requestId: string | null,
  event: string,
  payload: Record<string, unknown>,
): void {
  const prefix = requestId ? `[fact-check:${requestId}]` : "[fact-check]";
  console.log(`${prefix} ${event} ${JSON.stringify(payload)}`);
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
