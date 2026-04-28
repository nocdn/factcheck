import { Hono } from "hono";
import {
  cohereApiKey,
  directModeTimeoutMs,
  exaApiKey,
  factCheckDownloadQuality,
  factCheckMaxOutputTokens,
  geminiApiKey,
  geminiTimeoutMs,
  inlineVideoMaxBytes,
  resolveExaSearchType,
  resolveGeminiSettings,
  socialsMaxSearches,
  socialsResultsPerSearch,
  videoDownloadApiUrl,
  youtubeMaxSearches,
  youtubeResultsPerSearch,
} from "../config";
import { buildFactCheckPrompt } from "../prompts/factcheck";
import { buildSystemInstruction } from "../prompts/system";
import { transcribeAudioWithCohere } from "../services/cohere";
import { buildSearchContext, buildWarnings, runExaSearches } from "../services/exa";
import {
  createSearchPlan,
  createTranscriptSearchPlan,
  createWebpageSearchPlan,
  delayBeforeGeminiStep,
  extractThoughtText,
  generateGeminiContentWithRetry,
} from "../services/gemini";
import {
  downloadAudioForTranscription,
  downloadVideoForInlineUse,
} from "../services/downloader";
import { factCheckJobs } from "../store";
import type {
  ParsedFactCheckRequest,
} from "../types";
import { HttpError, normalizeFactCheckError } from "../utils/errors";
import { combineAbortSignals, delay, normalizeMimeType } from "../utils/helpers";
import { logEvent, truncate } from "../utils/logging";
import { createJobId, createRequestId } from "../utils/ids";
import { resolveUrlProcessingMode } from "../utils/validation";
import { factCheckJsonBodySchema, formatZodErrors } from "../schemas";

const check = new Hono();

check.post("/", async (c) => {
  if (!geminiApiKey) {
    return c.json(
      {
        error: "Gemini is not configured. Set GEMINI_API_KEY.",
      },
      500,
    );
  }

  if (!exaApiKey) {
    return c.json(
      {
        error: "Exa is not configured. Set EXA_API_KEY.",
      },
      500,
    );
  }

  const parsedBody = await parseFactCheckRequest(c.req.raw);

  if ("error" in parsedBody) {
    return c.json({ error: parsedBody.error }, parsedBody.status);
  }

  if (
    parsedBody.inputMode === "url" &&
    parsedBody.urlMode === "transcript" &&
    !cohereApiKey
  ) {
    return c.json(
      {
        error:
          "Cohere is not configured. Set COHERE_API_KEY to enable YouTube transcript fact-checking.",
      },
      500,
    );
  }

  const requestId =
    parsedBody.mode === "queue" ? createJobId() : createRequestId();
  logEvent(requestId, "fact_check_request_received", {
    requestMode: parsedBody.mode,
    inputMode: parsedBody.inputMode,
    url: parsedBody.url,
    filename: parsedBody.inputMode === "file" ? parsedBody.filename : null,
    mimeType: parsedBody.inputMode === "file" ? parsedBody.mimeType : null,
    sizeBytes: parsedBody.inputMode === "file" ? parsedBody.sizeBytes : null,
    quality: parsedBody.inputMode === "url" ? parsedBody.quality : null,
    iosCompatible:
      parsedBody.inputMode === "url" ? parsedBody.iosCompatible : null,
    proxy: parsedBody.inputMode === "url" ? parsedBody.proxy : null,
    urlMode: parsedBody.inputMode === "url" ? parsedBody.urlMode : null,
    additionalContextLength: parsedBody.additionalContext?.length ?? 0,
    inlineVideoMaxBytes,
    geminiModels: parsedBody.models,
    reasoningEffort: parsedBody.reasoningEffort,
  });

  if (parsedBody.mode === "queue") {
    factCheckJobs.set(requestId, {
      createdAt: Date.now(),
      status: "processing",
    });

    runQueuedFactCheck(requestId, parsedBody);

    return c.json({
      id: requestId,
      ready: false,
    });
  }

  const clientSignal = c.req.raw.signal;
  const abortController = new AbortController();
  const requestSignal = clientSignal
    ? combineAbortSignals(clientSignal, abortController.signal)
    : abortController.signal;

  // Direct mode end-to-end timeout
  const directTimeout = setTimeout(() => {
    abortController.abort();
  }, directModeTimeoutMs);

  try {
    return c.json(await runFactCheck(requestId, parsedBody, requestSignal));
  } finally {
    clearTimeout(directTimeout);
  }
});

export default check;

function logGeminiResponse(
  requestId: string,
  response: import("../services/gemini").GeminiGenerateContentResponse,
  candidate: import("../services/gemini").GeminiGenerateContentResponse["candidates"][number] | undefined,
  searchPlan: { searches: import("../types").SearchQuery[] },
  searchResults: import("../types").SearchResultContext[],
  reasoning: string | null,
  analysis: string,
  warnings: string[],
  extra?: Record<string, unknown>,
): void {
  logEvent(requestId, "gemini_response_received", {
    responseId: response.responseId ?? null,
    modelVersion: response.modelVersion ?? null,
    finishReason: candidate?.finishReason ?? null,
    finishMessage: candidate?.finishMessage ?? null,
    promptTokenCount: response.usageMetadata?.promptTokenCount ?? null,
    candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
    thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount ?? null,
    toolUsePromptTokenCount:
      response.usageMetadata?.toolUsePromptTokenCount ?? null,
    totalTokenCount: response.usageMetadata?.totalTokenCount ?? null,
    exaSearchQueries: searchPlan.searches,
    exaSources: searchResults.map((result) => ({
      query: result.query,
      title: result.title,
      uri: result.url,
      publishedDate: result.publishedDate,
    })),
    reasoningPreview: reasoning ? truncate(reasoning, 3000) : null,
    analysisPreview: truncate(analysis, 5000),
    warnings,
    ...extra,
  });
}

function buildResponse(
  requestId: string,
  parsedBody: ParsedFactCheckRequest,
  analysis: string,
  reasoning: string | null,
  searchPlan: { searches: import("../types").SearchQuery[] },
  searchResults: import("../types").SearchResultContext[],
  response: import("../services/gemini").GeminiGenerateContentResponse,
  warnings: string[],
  extras: {
    download?: import("../types").FactCheckResponse["download"];
    uploadedFile?: import("../types").FactCheckResponse["uploadedFile"];
    transcription?: import("../types").FactCheckResponse["transcription"];
    webpage?: import("../types").FactCheckResponse["webpage"];
  },
): import("../types").FactCheckResponse {
  return {
    id: requestId,
    inputMode: parsedBody.inputMode,
    url: parsedBody.url,
    model:
      parsedBody.models.searchPlan === parsedBody.models.finalAnswer
        ? parsedBody.models.searchPlan
        : [parsedBody.models.searchPlan, parsedBody.models.finalAnswer],
    models: parsedBody.models,
    reasoningEffort: parsedBody.reasoningEffort,
    analysis,
    reasoning,
    download: extras.download ?? null,
    uploadedFile: extras.uploadedFile ?? null,
    transcription: extras.transcription ?? null,
    webpage: extras.webpage ?? null,
    research: {
      provider: "exa",
      searchType: parsedBody.searchType,
      queries: searchPlan.searches,
      results: searchResults.map((result) => ({
        query: result.query,
        title: result.title,
        url: result.url,
        publishedDate: result.publishedDate,
        author: result.author,
      })),
    },
    usage: response.usageMetadata
      ? {
          promptTokenCount: response.usageMetadata.promptTokenCount ?? null,
          candidatesTokenCount:
            response.usageMetadata.candidatesTokenCount ?? null,
          thoughtsTokenCount: response.usageMetadata.thoughtsTokenCount ?? null,
          toolUsePromptTokenCount:
            response.usageMetadata.toolUsePromptTokenCount ?? null,
          totalTokenCount: response.usageMetadata.totalTokenCount ?? null,
        }
      : null,
    warnings,
  };
}

async function runQueuedFactCheck(
  requestId: string,
  input: ParsedFactCheckRequest,
): Promise<void> {
  try {
    const result = await runFactCheck(requestId, input);
    factCheckJobs.set(requestId, {
      completedAt: Date.now(),
      createdAt: factCheckJobs.get(requestId)?.createdAt ?? Date.now(),
      result,
      status: "completed",
    });
  } catch (error) {
    console.error(`[fact-check:${requestId}]`, error);
    const normalized = normalizeFactCheckError(error);
    factCheckJobs.set(requestId, {
      completedAt: Date.now(),
      createdAt: factCheckJobs.get(requestId)?.createdAt ?? Date.now(),
      error: normalized.error,
      status: "failed",
      statusCode: normalized.status,
    });
  }
}

async function runFactCheck(
  requestId: string,
  parsedBody: ParsedFactCheckRequest,
  abortSignal?: AbortSignal,
): Promise<import("../types").FactCheckResponse> {
  if (parsedBody.inputMode === "url" && parsedBody.urlMode === "transcript") {
    return runTranscriptFactCheck(requestId, parsedBody, abortSignal);
  }

  if (parsedBody.inputMode === "url" && parsedBody.urlMode === "webpage") {
    return runWebpageFactCheck(requestId, parsedBody, abortSignal);
  }

  const videoInput =
    parsedBody.inputMode === "url"
      ? await downloadVideoForInlineUse(requestId, {
          ...parsedBody,
          downloadMode: "video",
        }, abortSignal)
      : {
          bytes: parsedBody.bytes,
          filename: parsedBody.filename,
          mimeType: parsedBody.mimeType,
          sizeBytes: parsedBody.sizeBytes,
        };

  if (parsedBody.inputMode === "file") {
    logEvent(requestId, "video_upload_received", {
      filename: parsedBody.filename,
      mimeType: parsedBody.mimeType,
      sizeBytes: parsedBody.sizeBytes,
      sourceUrl: parsedBody.url,
    });
  }

  const prompt = buildFactCheckPrompt("video", {
    url: parsedBody.url,
    additionalContext: parsedBody.additionalContext,
  });
  const searchPlan = await createSearchPlan(
    requestId,
    videoInput,
    prompt,
    parsedBody,
    socialsMaxSearches,
    abortSignal,
  );
  const searchResults = await runExaSearches(
    requestId,
    searchPlan.searches,
    socialsResultsPerSearch,
    parsedBody.searchType,
    [],
    abortSignal,
  );
  const searchContext = buildSearchContext(searchResults, searchPlan.searches);
  const finalPrompt = buildFactCheckPrompt("video", {
    url: parsedBody.url,
    additionalContext: parsedBody.additionalContext,
    searchContext,
  });

  await delayBeforeGeminiStep(requestId, "final_answer");

  logEvent(requestId, "gemini_request_prepared", {
    inputMode: parsedBody.inputMode,
    sourceUrl: parsedBody.url,
    mimeType: videoInput.mimeType,
    sizeBytes: videoInput.sizeBytes,
    filename: videoInput.filename,
    systemInstructionPreview: truncate(buildSystemInstruction("video"), 300),
    promptPreview: truncate(finalPrompt, 500),
    responseMimeType: "text/plain",
    thinkingLevel: parsedBody.thinkingLevel,
    geminiModel: parsedBody.models.finalAnswer,
    exaSearchEnabled: true,
    exaSearchType: parsedBody.searchType,
    exaSearchQueryActualCount: searchPlan.searches.length,
    exaSearchResultCount: searchResults.length,
    includeThoughts: true,
  });

  const response = await generateGeminiContentWithRetry(
    requestId,
    "final_answer",
    {
      model: parsedBody.models.finalAnswer,
      contents: [
        {
          inlineData: {
            mimeType: videoInput.mimeType,
            data: Buffer.from(videoInput.bytes).toString("base64"),
          },
        },
        {
          text: finalPrompt,
        },
      ],
      config: {
        abortSignal,
        maxOutputTokens: factCheckMaxOutputTokens,
        responseMimeType: "text/plain",
        systemInstruction: buildSystemInstruction("video"),
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: parsedBody.thinkingLevel,
        },
      },
    },
  );

  const analysis = response.text?.trim() || "";

  if (!analysis) {
    throw new HttpError(502, "Gemini returned an empty response.");
  }

  const candidate = response.candidates?.[0];
  const reasoning = extractThoughtText(candidate?.content?.parts);
  const warnings = buildWarnings(
    searchPlan.searches,
    searchResults,
    socialsMaxSearches,
    true,
  );

  logGeminiResponse(
    requestId,
    response,
    candidate,
    searchPlan,
    searchResults,
    reasoning,
    analysis,
    warnings,
  );

  return buildResponse(requestId, parsedBody, analysis, reasoning, searchPlan, searchResults, response, warnings, {
    download:
      parsedBody.inputMode === "url"
        ? {
            apiUrl: videoDownloadApiUrl,
            filename: videoInput.filename,
            mimeType: videoInput.mimeType,
            quality:
              "quality" in videoInput ? videoInput.quality : parsedBody.quality,
            requestedQuality: parsedBody.quality,
            sizeBytes: videoInput.sizeBytes,
            iosCompatible: parsedBody.iosCompatible,
            proxy: parsedBody.proxy,
          }
        : undefined,
    uploadedFile:
      parsedBody.inputMode === "file"
        ? {
            filename: videoInput.filename,
            mimeType: videoInput.mimeType,
            sizeBytes: videoInput.sizeBytes,
          }
        : undefined,
  });
}

async function runTranscriptFactCheck(
  requestId: string,
  parsedBody: Extract<ParsedFactCheckRequest, { inputMode: "url" }>,
  abortSignal?: AbortSignal,
): Promise<import("../types").FactCheckResponse> {
  const audioInput = await downloadAudioForTranscription(requestId, {
    downloadMode: "audio",
    iosCompatible: parsedBody.iosCompatible,
    proxy: parsedBody.proxy,
    quality: parsedBody.quality,
    url: parsedBody.url,
  }, abortSignal);

  const transcript = await transcribeAudioWithCohere(requestId, audioInput, abortSignal);

  const searchPlan = await createTranscriptSearchPlan(
    requestId,
    transcript,
    parsedBody.url,
    parsedBody.additionalContext,
    parsedBody,
    youtubeMaxSearches,
    abortSignal,
  );

  const searchResults = await runExaSearches(
    requestId,
    searchPlan.searches,
    youtubeResultsPerSearch,
    parsedBody.searchType,
    [],
    abortSignal,
  );
  const searchContext = buildSearchContext(searchResults, searchPlan.searches);
  const finalPrompt = buildFactCheckPrompt("transcript", {
    url: parsedBody.url,
    additionalContext: parsedBody.additionalContext,
    transcript,
    searchContext,
  });

  await delayBeforeGeminiStep(requestId, "final_answer");

  logEvent(requestId, "gemini_request_prepared", {
    inputMode: "url",
    sourceUrl: parsedBody.url,
    transcriptCharacters: transcript.length,
    audioMimeType: audioInput.mimeType,
    audioSizeBytes: audioInput.sizeBytes,
    audioFilename: audioInput.filename,
    systemInstructionPreview: truncate(
      buildSystemInstruction("transcript"),
      300,
    ),
    promptPreview: truncate(finalPrompt, 500),
    responseMimeType: "text/plain",
    thinkingLevel: parsedBody.thinkingLevel,
    geminiModel: parsedBody.models.finalAnswer,
    exaSearchEnabled: true,
    exaSearchType: parsedBody.searchType,
    exaSearchQueryActualCount: searchPlan.searches.length,
    exaSearchResultCount: searchResults.length,
    includeThoughts: true,
    transcriptMode: true,
  });

  const response = await generateGeminiContentWithRetry(
    requestId,
    "final_answer",
    {
      model: parsedBody.models.finalAnswer,
      contents: [
        {
          text: finalPrompt,
        },
      ],
      config: {
        abortSignal,
        maxOutputTokens: factCheckMaxOutputTokens,
        responseMimeType: "text/plain",
        systemInstruction: buildSystemInstruction("transcript"),
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: parsedBody.thinkingLevel,
        },
      },
    },
  );

  const analysis = response.text?.trim() || "";

  if (!analysis) {
    throw new HttpError(502, "Gemini returned an empty response.");
  }

  const candidate = response.candidates?.[0];
  const reasoning = extractThoughtText(candidate?.content?.parts);
  const warnings = buildWarnings(
    searchPlan.searches,
    searchResults,
    youtubeMaxSearches,
    true,
  );

  logGeminiResponse(
    requestId,
    response,
    candidate,
    searchPlan,
    searchResults,
    reasoning,
    analysis,
    warnings,
    { transcriptMode: true },
  );

  return buildResponse(requestId, parsedBody, analysis, reasoning, searchPlan, searchResults, response, warnings, {
    transcription: {
      provider: "cohere",
      model: "cohere-transcribe-03-2026",
      language: "en",
      characterCount: transcript.length,
      audio: {
        apiUrl: videoDownloadApiUrl,
        filename: audioInput.filename,
        mimeType: audioInput.mimeType,
        sizeBytes: audioInput.sizeBytes,
        iosCompatible: parsedBody.iosCompatible,
        proxy: parsedBody.proxy,
      },
    },
  });
}

import {
  articleMaxSearches,
  articleResultsPerSearch,
  exaTextMaxCharacters,
} from "../config";
import { getExaWebpageContent } from "../services/exa";

async function runWebpageFactCheck(
  requestId: string,
  parsedBody: Extract<ParsedFactCheckRequest, { inputMode: "url" }>,
  abortSignal?: AbortSignal,
): Promise<import("../types").FactCheckResponse> {
  const webpage = await getExaWebpageContent(requestId, parsedBody.url, abortSignal);
  const searchPlan = await createWebpageSearchPlan(
    requestId,
    webpage,
    parsedBody.additionalContext,
    parsedBody,
    articleMaxSearches,
    abortSignal,
  );
  const searchResults = await runExaSearches(
    requestId,
    searchPlan.searches,
    articleResultsPerSearch,
    parsedBody.searchType,
    [parsedBody.url, webpage.url],
    abortSignal,
  );
  const searchContext = buildSearchContext(searchResults, searchPlan.searches);
  const finalPrompt = buildFactCheckPrompt("webpage", {
    additionalContext: parsedBody.additionalContext,
    webpage,
    searchContext,
  });

  await delayBeforeGeminiStep(requestId, "final_answer");

  logEvent(requestId, "gemini_request_prepared", {
    inputMode: "url",
    urlMode: "webpage",
    sourceUrl: parsedBody.url,
    webpageUrl: webpage.url,
    webpageTitle: webpage.title,
    webpageCharacters: webpage.text.length,
    webpageTruncated: webpage.truncated,
    systemInstructionPreview: truncate(buildSystemInstruction("webpage"), 300),
    promptPreview: truncate(finalPrompt, 500),
    responseMimeType: "text/plain",
    thinkingLevel: parsedBody.thinkingLevel,
    geminiModel: parsedBody.models.finalAnswer,
    exaSearchEnabled: true,
    exaSearchType: parsedBody.searchType,
    exaSearchQueryActualCount: searchPlan.searches.length,
    exaSearchResultCount: searchResults.length,
    includeThoughts: true,
  });

  const response = await generateGeminiContentWithRetry(
    requestId,
    "final_answer",
    {
      model: parsedBody.models.finalAnswer,
      contents: [
        {
          text: finalPrompt,
        },
      ],
      config: {
        abortSignal,
        maxOutputTokens: factCheckMaxOutputTokens,
        responseMimeType: "text/plain",
        systemInstruction: buildSystemInstruction("webpage"),
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: parsedBody.thinkingLevel,
        },
      },
    },
  );

  const analysis = response.text?.trim() || "";

  if (!analysis) {
    throw new HttpError(502, "Gemini returned an empty response.");
  }

  const candidate = response.candidates?.[0];
  const reasoning = extractThoughtText(candidate?.content?.parts);
  const warnings = buildWarnings(
    searchPlan.searches,
    searchResults,
    articleMaxSearches,
    true,
  );

  if (webpage.truncated) {
    warnings.push(
      `Exa returned more article text than EXA_SEARCH_TEXT_MAX_CHARACTERS (${exaTextMaxCharacters}); the article was truncated before Gemini analysis.`,
    );
  }

  logGeminiResponse(
    requestId,
    response,
    candidate,
    searchPlan,
    searchResults,
    reasoning,
    analysis,
    warnings,
    { webpageMode: true },
  );

  return buildResponse(requestId, parsedBody, analysis, reasoning, searchPlan, searchResults, response, warnings, {
    webpage: {
      provider: "exa",
      title: webpage.title,
      url: webpage.url,
      publishedDate: webpage.publishedDate,
      author: webpage.author,
      characterCount: webpage.text.length,
      truncated: webpage.truncated,
    },
  });
}

async function parseFactCheckRequest(
  request: Request,
): Promise<ParsedFactCheckRequest | { error: string; status: 400 | 413 }> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.startsWith("multipart/form-data")) {
    return parseMultipartFactCheckRequest(request);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { error: "Request body must be valid JSON.", status: 400 };
  }

  let parsed;
  try {
    parsed = factCheckJsonBodySchema.safeParse(rawBody);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid request.";
    return { error: message, status: 400 };
  }

  if (!parsed.success) {
    return { error: formatZodErrors(parsed.error), status: 400 };
  }

  const data = parsed.data;

  try {
    const geminiSettings = resolveGeminiSettings(
      data.resolvedModel,
      data.reasoningEffort,
    );

    const urlMode = resolveUrlProcessingMode(data.parsedUrl, data.sourceType);

    return {
      additionalContext:
        data.additionalContext?.trim() ? data.additionalContext.trim() : null,
      inputMode: "url",
      iosCompatible: data.iosCompatible,
      mode: data.mode as "direct" | "queue",
      models: geminiSettings.models,
      proxy: data.proxy,
      quality: data.quality,
      reasoningEffort: geminiSettings.reasoningEffort,
      searchType: data.searchType as import("../types").ExaSearchType,
      thinkingLevel: geminiSettings.thinkingLevel,
      url: data.parsedUrl.toString(),
      urlMode,
      useTranscript: urlMode === "transcript",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid request.";
    return { error: message, status: 400 };
  }
}

async function parseMultipartFactCheckRequest(
  request: Request,
): Promise<ParsedFactCheckRequest | { error: string; status: 400 | 413 }> {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return { error: "Multipart body could not be parsed.", status: 400 };
  }

  const fileEntry = formData.get("file");

  if (!(fileEntry instanceof File)) {
    return {
      error:
        "Multipart requests must include a file field containing the video file.",
      status: 400,
    };
  }

  if (fileEntry.size === 0) {
    return { error: "The uploaded file is empty.", status: 400 };
  }

  if (fileEntry.size > inlineVideoMaxBytes) {
    return {
      error: `Uploaded video is ${fileEntry.size} bytes, which exceeds INLINE_VIDEO_MAX_BYTES (${inlineVideoMaxBytes}).`,
      status: 413,
    };
  }

  const mimeType = normalizeMimeType(fileEntry.type || null);

  if (!mimeType.startsWith("video/")) {
    return {
      error: "The uploaded file must have a video MIME type.",
      status: 400,
    };
  }

  const sourceUrlEntry = formData.get("url");
  let sourceUrl: string | null = null;

  if (typeof sourceUrlEntry === "string" && sourceUrlEntry.trim()) {
    try {
      const parsedSourceUrl = new URL(sourceUrlEntry.trim());

      if (!["http:", "https:"].includes(parsedSourceUrl.protocol)) {
        return {
          error: "The optional url field must use http or https.",
          status: 400,
        };
      }

      sourceUrl = parsedSourceUrl.toString();
    } catch {
      return {
        error: "The optional url field must be a valid absolute URL.",
        status: 400,
      };
    }
  }

  const additionalContextEntry = formData.get("additionalContext");
  const modelEntry = formData.get("model");
  const reasoningEffortEntry = formData.get("reasoningEffort");
  const effortEntry = formData.get("effort");
  const modeEntry = formData.get("mode");
  const searchTypeEntry = formData.get("searchType");

  const mode =
    typeof modeEntry === "string" && modeEntry.trim()
      ? modeEntry.trim().toLowerCase()
      : "direct";
  if (mode !== "direct" && mode !== "queue") {
    return { error: "The mode field must be either direct or queue.", status: 400 };
  }

  const reasoningEffortStr =
    (typeof reasoningEffortEntry === "string" && reasoningEffortEntry.trim()
      ? reasoningEffortEntry.trim()
      : undefined) ??
    (typeof effortEntry === "string" && effortEntry.trim()
      ? effortEntry.trim()
      : undefined);

  let resolvedSearchType: string;
  try {
    resolvedSearchType = resolveExaSearchType(
      typeof searchTypeEntry === "string" ? searchTypeEntry : undefined,
      "auto",
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid searchType.";
    return { error: message, status: 400 };
  }

  let geminiSettings: ReturnType<typeof resolveGeminiSettings>;
  try {
    let rawModel: string | string[] | undefined;
    if (typeof modelEntry === "string" && modelEntry.trim()) {
      const trimmed = modelEntry.trim();
      rawModel = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed;
    }

    geminiSettings = resolveGeminiSettings(rawModel, reasoningEffortStr);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid Gemini settings.";
    return { error: message, status: 400 };
  }

  const arrayBuffer = await fileEntry.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  if (bytes.byteLength > inlineVideoMaxBytes) {
    return {
      error: `Uploaded video is ${bytes.byteLength} bytes, which exceeds INLINE_VIDEO_MAX_BYTES (${inlineVideoMaxBytes}).`,
      status: 413,
    };
  }

  return {
    additionalContext:
      typeof additionalContextEntry === "string" &&
      additionalContextEntry.trim()
        ? additionalContextEntry.trim()
        : null,
    bytes,
    filename: fileEntry.name || `${createRequestId()}.mp4`,
    inputMode: "file",
    mimeType,
    mode: mode as "direct" | "queue",
    models: geminiSettings.models,
    reasoningEffort: geminiSettings.reasoningEffort,
    searchType: resolvedSearchType as import("../types").ExaSearchType,
    sizeBytes: bytes.byteLength,
    thinkingLevel: geminiSettings.thinkingLevel,
    url: sourceUrl,
  };
}
