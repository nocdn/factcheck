import type { ErrorStatus } from "../types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function normalizeFactCheckError(error: unknown): {
  error: string;
  status: ErrorStatus;
} {
  if (error instanceof HttpError) {
    return {
      error: error.message,
      status: isSupportedErrorStatus(error.status) ? error.status : 500,
    };
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { error: "The upstream request timed out.", status: 504 };
  }

  const status = getErrorStatus(error);

  if (status && isSupportedErrorStatus(status)) {
    return {
      error:
        error instanceof Error ? error.message : "The upstream request failed.",
      status,
    };
  }

  if (error instanceof Error) {
    return { error: error.message, status: 500 };
  }

  return { error: "Unknown error.", status: 500 };
}

export function isSupportedErrorStatus(status: number): status is ErrorStatus {
  return [400, 413, 429, 500, 502, 503, 504].includes(status);
}

export async function throwIfNotOk(
  response: Response,
  serviceName: string,
  statusOverride?: number,
): Promise<void> {
  if (response.ok) return;

  const errorText = await response.text().catch(() => "");
  const status = statusOverride ?? (response.status === 429 ? 429 : 502);
  throw new HttpError(
    status,
    `${serviceName} failed with status ${response.status}.${errorText ? ` ${errorText.slice(0, 500)}${errorText.length > 500 ? "..." : ""}` : ""}`,
  );
}

export function isGeminiHighDemandError(error: unknown): boolean {
  const status = getErrorStatus(error);
  const message =
    error instanceof Error ? error.message : JSON.stringify(error);

  return (
    status === 503 &&
    (message.toLowerCase().includes("high demand") ||
      message.includes('"UNAVAILABLE"') ||
      message.toLowerCase().includes("currently unavailable"))
  );
}

export function getErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  const status = error.status;

  if (typeof status === "number") {
    return status;
  }

  if (typeof status === "string") {
    const parsed = Number.parseInt(status, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
