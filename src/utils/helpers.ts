import { HttpError } from "./errors";
import { logEvent } from "./logging";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function limitText(
  value: string,
  maxCharacters: number,
): { text: string; truncated: boolean } {
  if (maxCharacters > 0 && value.length > maxCharacters) {
    return {
      text: `${value.slice(0, maxCharacters).trimEnd()}\n\n[Text truncated at ${maxCharacters} characters.]`,
      truncated: true,
    };
  }

  return {
    text: value,
    truncated: false,
  };
}

export function normalizeUrlKey(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim() || null;
  }
}

export function normalizeMimeType(value: string | null): string {
  const mimeType = value?.split(";")[0]?.trim().toLowerCase();

  if (!mimeType || mimeType === "application/octet-stream") {
    return "video/mp4";
  }

  return mimeType;
}

export function normalizeAudioMimeType(value: string | null): string {
  const mimeType = value?.split(";")[0]?.trim().toLowerCase();

  if (!mimeType || mimeType === "application/octet-stream") {
    return "audio/mpeg";
  }

  return mimeType;
}

export function combineAbortSignals(
  ...signals: (AbortSignal | undefined | null)[]
): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => s !== null && s !== undefined);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];

  const controller = new AbortController();
  const onAbort = () => controller.abort();

  for (const signal of valid) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  controller.signal.addEventListener("abort", () => {
    for (const signal of valid) {
      signal.removeEventListener("abort", onAbort);
    }
  }, { once: true });

  return controller.signal;
}

export function checkByteLimits(
  contentLengthHeader: string | null,
  actualBytes: number,
  maxBytes: number,
  resourceName: string,
): void {
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      throw new HttpError(
        413,
        `${resourceName} is ${contentLength} bytes, which exceeds the limit of ${maxBytes} bytes. Lower the quality or raise the limit.`,
      );
    }
  }

  if (actualBytes > maxBytes) {
    throw new HttpError(
      413,
      `${resourceName} is ${actualBytes} bytes, which exceeds the limit of ${maxBytes} bytes. Lower the quality or raise the limit.`,
    );
  }
}

export async function fetchWithRetry(
  fetchFn: () => Promise<Response>,
  options: {
    maxRetries: number;
    retryDelayMs: number;
    retryableStatuses: number[];
    serviceName: string;
    requestId: string | null;
  },
): Promise<Response> {
  const { maxRetries, retryDelayMs, retryableStatuses, serviceName, requestId } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchFn();
      if (response.ok || !retryableStatuses.includes(response.status)) {
        return response;
      }
      lastError = new Error(
        `${serviceName} failed with status ${response.status}`,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < maxRetries) {
      if (requestId) {
        logEvent(requestId, `${serviceName}_retry_scheduled`, {
          attempt: attempt + 1,
          delayMs: retryDelayMs,
          maxRetries,
        });
      }
      await delay(retryDelayMs);
    }
  }

  throw lastError ?? new Error(`${serviceName} failed after ${maxRetries} retries.`);
}

export function getFilenameFromHeaders(headers: Headers): string | null {
  const disposition = headers.get("content-disposition");

  if (!disposition) {
    return null;
  }

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);

  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }

  const plainMatch = disposition.match(/filename="?([^"]+)"?/i);
  return plainMatch?.[1] ?? null;
}
