import {
  downloadTimeoutMs,
  downloaderRetryCount,
  downloaderRetryDelayMs,
  inlineVideoMaxBytes,
  videoDownloadApiUrl,
  youtubeAudioMaxBytes,
  youtubeAudioQuality,
} from "../config";
import type { UrlFactCheckInput } from "../types";
import { HttpError, throwIfNotOk } from "../utils/errors";
import {
  checkByteLimits,
  combineAbortSignals,
  fetchWithRetry,
  getFilenameFromHeaders,
  normalizeAudioMimeType,
  normalizeMimeType,
} from "../utils/helpers";
import { createRequestId } from "../utils/ids";
import { logEvent, truncate } from "../utils/logging";

export async function downloadVideoForInlineUse(
  requestId: string,
  input: UrlFactCheckInput,
  clientSignal?: AbortSignal,
): Promise<{
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  quality: string;
  sizeBytes: number;
}> {
  logEvent(requestId, "video_download_started", {
    sourceUrl: input.url,
    downloaderUrl: videoDownloadApiUrl,
    quality: input.quality,
    iosCompatible: input.iosCompatible,
    proxy: input.proxy,
  });

  let response = await fetchDownloadVideo(requestId, input, clientSignal);
  let downloadedQuality = input.quality;

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");

    if (input.quality !== "best" && isUnavailableFormatError(errorText)) {
      logEvent(requestId, "video_download_quality_fallback_started", {
        sourceUrl: input.url,
        downloaderUrl: videoDownloadApiUrl,
        requestedQuality: input.quality,
        fallbackQuality: "best",
        upstreamStatus: response.status,
        upstreamError: truncate(errorText, 500),
      });

      response = await fetchDownloadVideo(requestId, { ...input, quality: "best" });

      if (response.ok) {
        downloadedQuality = "best";
        logEvent(requestId, "video_download_quality_fallback_succeeded", {
          sourceUrl: input.url,
          downloaderUrl: videoDownloadApiUrl,
          requestedQuality: input.quality,
          fallbackQuality: "best",
          status: response.status,
        });
      }
    }
  }

  await throwIfNotOk(response, "Video download API");

  const contentLengthHeader = response.headers.get("content-length");
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  checkByteLimits(
    contentLengthHeader,
    bytes.byteLength,
    inlineVideoMaxBytes,
    "Downloaded video",
  );

  const result = {
    bytes,
    filename:
      getFilenameFromHeaders(response.headers) || `${createRequestId()}.mp4`,
    mimeType: normalizeMimeType(response.headers.get("content-type")),
    quality: downloadedQuality,
    sizeBytes: bytes.byteLength,
  };

  logEvent(requestId, "video_download_completed", {
    sourceUrl: input.url,
    downloaderUrl: videoDownloadApiUrl,
    quality: result.quality,
    requestedQuality: input.quality,
    iosCompatible: input.iosCompatible,
    proxy: input.proxy,
    status: response.status,
    filename: result.filename,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes,
    contentLengthHeader: contentLengthHeader ?? null,
  });

  return result;
}

export function fetchDownloadVideo(
  requestId: string,
  input: UrlFactCheckInput,
  clientSignal?: AbortSignal,
): Promise<Response> {
  const isAudio = input.downloadMode === "audio";

  const body: Record<string, unknown> = {
    url: input.url,
    mode: isAudio ? "audio" : "both",
    iosCompatible: input.iosCompatible,
    proxy: input.proxy,
    playlist: false,
  };

  if (isAudio) {
    body.audioQuality = youtubeAudioQuality;
  } else {
    body.quality = input.quality;
  }

  const signal = combineAbortSignals(
    clientSignal,
    AbortSignal.timeout(downloadTimeoutMs),
  );

  return fetchWithRetry(
    () =>
      fetch(videoDownloadApiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      }),
    {
      maxRetries: downloaderRetryCount,
      retryDelayMs: downloaderRetryDelayMs,
      retryableStatuses: [429, 502, 503, 504],
      serviceName: "Video downloader",
      requestId,
    },
  );
}

export function isUnavailableFormatError(errorText: string): boolean {
  return errorText.toLowerCase().includes("requested format is not available");
}

export async function downloadAudioForTranscription(
  requestId: string,
  input: UrlFactCheckInput,
  clientSignal?: AbortSignal,
): Promise<{
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}> {
  logEvent(requestId, "audio_download_started", {
    sourceUrl: input.url,
    downloaderUrl: videoDownloadApiUrl,
    audioQuality: youtubeAudioQuality,
    proxy: input.proxy,
    iosCompatible: input.iosCompatible,
  });

  const response = await fetchDownloadVideo(requestId, {
    ...input,
    downloadMode: "audio",
  }, clientSignal);

  await throwIfNotOk(response, "Audio download API");

  const contentLengthHeader = response.headers.get("content-length");
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  checkByteLimits(
    contentLengthHeader,
    bytes.byteLength,
    youtubeAudioMaxBytes,
    "Downloaded audio",
  );

  const mimeType = normalizeAudioMimeType(response.headers.get("content-type"));
  const filename =
    getFilenameFromHeaders(response.headers) || `${createRequestId()}.mp3`;

  logEvent(requestId, "audio_download_completed", {
    sourceUrl: input.url,
    downloaderUrl: videoDownloadApiUrl,
    status: response.status,
    filename,
    mimeType,
    sizeBytes: bytes.byteLength,
    contentLengthHeader: contentLengthHeader ?? null,
  });

  return {
    bytes,
    filename,
    mimeType,
    sizeBytes: bytes.byteLength,
  };
}
