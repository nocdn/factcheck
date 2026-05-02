import {
  cohereApiKey,
  cohereRetryCount,
  cohereRetryDelayMs,
  cohereTranscribeLanguage,
  cohereTranscribeModel,
  cohereTranscribeTimeoutMs,
} from "../config";
import { throwIfNotOk } from "../utils/errors";
import { combineAbortSignals, fetchWithRetry } from "../utils/helpers";
import { logPreviewLimits, truncate } from "../utils/logging";
import { isRecord } from "../utils/validation";
import { logEvent } from "../utils/logging";

export async function transcribeAudioWithCohere(
  requestId: string,
  audio: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  },
  clientSignal?: AbortSignal,
): Promise<string> {
  logEvent(requestId, "cohere_transcribe_started", {
    model: cohereTranscribeModel,
    language: cohereTranscribeLanguage,
    audioFilename: audio.filename,
    audioMimeType: audio.mimeType,
    audioSizeBytes: audio.sizeBytes,
  });

  const formData = new FormData();
  formData.append("model", cohereTranscribeModel);
  formData.append("language", cohereTranscribeLanguage);
  formData.append(
    "file",
    new Blob([Buffer.from(audio.bytes)], { type: audio.mimeType }),
    audio.filename,
  );

  const signal = combineAbortSignals(
    clientSignal,
    AbortSignal.timeout(cohereTranscribeTimeoutMs),
  );

  const response = await fetchWithRetry(
    () =>
      fetch("https://api.cohere.com/v2/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cohereApiKey}`,
        },
        body: formData,
        signal,
      }),
    {
      maxRetries: cohereRetryCount,
      retryDelayMs: cohereRetryDelayMs,
      retryableStatuses: [429, 502, 503, 504],
      serviceName: "Cohere transcription",
      requestId,
    },
  );

  await throwIfNotOk(response, "Cohere transcription", response.status === 429 ? 429 : 502);

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new Error("Cohere returned a response that was not valid JSON.");
  }

  const transcript =
    isRecord(body) && typeof body.text === "string" ? body.text.trim() : "";

  if (!transcript) {
    throw new Error("Cohere returned an empty transcript.");
  }

  logEvent(requestId, "cohere_transcribe_completed", {
    model: cohereTranscribeModel,
    language: cohereTranscribeLanguage,
    transcriptCharacters: transcript.length,
    transcriptPreview: truncate(transcript, logPreviewLimits.transcript),
  });

  return transcript;
}
