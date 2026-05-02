import { Hono } from "hono";
import {
  cohereApiKey,
  directModeTimeoutMs,
  exaApiKey,
  factCheckDownloadQuality,
  factCheckMaxOutputTokens,
  geminiApiKey,
  inlineVideoMaxBytes,
  openAiApiKey,
  resolveExaSearchType,
  resolveFactCheckSettings,
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
  createOpenAiTranscriptSearchPlan,
  createOpenAiWebpageSearchPlan,
  extractOpenAiText,
  generateOpenAiAnalysis,
} from "../services/openai";
import {
  downloadAudioForTranscription,
  downloadVideoForInlineUse,
} from "../services/downloader";
import { factCheckJobs } from "../store";
import type {
  FactCheckResponse,
  GeminiRequestSettings,
  OpenAiRequestSettings,
  ParsedFactCheckRequest,
} from "../types";
import { HttpError, normalizeFactCheckError } from "../utils/errors";
import { combineAbortSignals, delay, normalizeMimeType } from "../utils/helpers";
import { logEvent, logPreviewLimits, truncate } from "../utils/logging";
import { logger } from "../utils/logger";
import { createJobId, createRequestId } from "../utils/ids";
import { resolveUrlProcessingMode } from "../utils/validation";
import { factCheckJsonBodySchema, formatZodErrors } from "../schemas";

const check = new Hono();

check.post("/", async (c) => {
  const parsedBody = await parseFactCheckRequest(c.req.raw);

  if ("error" in parsedBody) {
    return c.json({ error: parsedBody.error }, parsedBody.status);
  }

  if (parsedBody.provider === "google" && !geminiApiKey) {
    return c.json(
      {
        error: "Gemini is not configured. Set GEMINI_API_KEY.",
      },
      500,
    );
  }

  if (parsedBody.provider === "openai" && !openAiApiKey) {
    return c.json(
      {
        error: "OpenAI is not configured. Set OPENAI_API_KEY.",
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

  if (
    parsedBody.inputMode === "url" &&
    parsedBody.urlMode === "transcript" &&
    !cohereApiKey
  ) {
    return c.json(
      {
        error:
          "Cohere is not configured. Set COHERE_API_KEY to enable transcript fact-checking.",
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
    speed: parsedBody.inputMode === "url" ? parsedBody.speed : null,
    additionalContextLength: parsedBody.additionalContext?.length ?? 0,
    inlineVideoMaxBytes,
    models: parsedBody.models,
    provider: parsedBody.provider,
    effort: parsedBody.effort,
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
    reasoningPreview: reasoning
      ? truncate(reasoning, logPreviewLimits.reasoning)
      : null,
    analysisPreview: truncate(analysis, logPreviewLimits.modelResponse),
    warnings,
    ...extra,
  });
}

function buildGeminiUsage(
  response: import("../services/gemini").GeminiGenerateContentResponse,
): FactCheckResponse["usage"] {
  if (!response.usageMetadata) {
    return null;
  }

  return {
    promptTokenCount: response.usageMetadata.promptTokenCount ?? null,
    candidatesTokenCount: response.usageMetadata.candidatesTokenCount ?? null,
    thoughtsTokenCount: response.usageMetadata.thoughtsTokenCount ?? null,
    toolUsePromptTokenCount:
      response.usageMetadata.toolUsePromptTokenCount ?? null,
    totalTokenCount: response.usageMetadata.totalTokenCount ?? null,
  };
}

function buildOpenAiUsage(
  response: import("../services/openai").OpenAiResponsesResponse,
): FactCheckResponse["usage"] {
  if (!response.usage) {
    return null;
  }

  return {
    promptTokenCount: response.usage.input_tokens ?? null,
    candidatesTokenCount: response.usage.output_tokens ?? null,
    thoughtsTokenCount:
      response.usage.output_tokens_details?.reasoning_tokens ?? null,
    toolUsePromptTokenCount: null,
    totalTokenCount: response.usage.total_tokens ?? null,
  };
}

function buildResponse(
  requestId: string,
  parsedBody: ParsedFactCheckRequest,
  analysis: string,
  reasoning: string | null,
  searchPlan: { searches: import("../types").SearchQuery[] },
  searchResults: import("../types").SearchResultContext[],
  usage: FactCheckResponse["usage"],
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
    provider: parsedBody.provider,
    model:
      parsedBody.models.searchPlan === parsedBody.models.finalAnswer
        ? parsedBody.models.searchPlan
        : [parsedBody.models.searchPlan, parsedBody.models.finalAnswer],
    models: parsedBody.models,
    effort: parsedBody.effort,
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
    usage,
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
    logger.error(
      { requestId, error: error instanceof Error ? error.message : String(error) },
      "Queued fact-check failed",
    );
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
  if (parsedBody.provider === "openai") {
    if (parsedBody.inputMode !== "url") {
      throw new HttpError(
        400,
        "OpenAI fact-checking only supports URL requests processed through text. Use provider google for direct video uploads.",
      );
    }

    if (parsedBody.urlMode === "transcript") {
      return runOpenAiTranscriptFactCheck(requestId, parsedBody, abortSignal);
    }

    if (parsedBody.urlMode === "webpage") {
      return runOpenAiWebpageFactCheck(requestId, parsedBody, abortSignal);
    }

    throw new HttpError(
      400,
      "OpenAI fact-checking only supports speed: fast for video URLs because OpenAI models cannot ingest video directly.",
    );
  }

  if (parsedBody.inputMode === "url" && parsedBody.urlMode === "transcript") {
    return runTranscriptFactCheck(requestId, parsedBody, abortSignal);
  }

  if (parsedBody.inputMode === "url" && parsedBody.urlMode === "webpage") {
    return runWebpageFactCheck(requestId, parsedBody, abortSignal);
  }

  if (parsedBody.inputMode === "url" && parsedBody.urlMode === "video") {
    return runSocialMediaFactCheckWithFallback(requestId, parsedBody, abortSignal);
  }

  return runInlineVideoFactCheck(requestId, parsedBody, abortSignal);
}

async function runSocialMediaFactCheckWithFallback(
  requestId: string,
  parsedBody: Extract<ParsedFactCheckRequest, { inputMode: "url" }>,
  abortSignal?: AbortSignal,
): Promise<import("../types").FactCheckResponse> {
  try {
    return await runInlineVideoFactCheck(requestId, parsedBody, abortSignal);
  } catch (firstError) {
    logEvent(requestId, "video_fact_check_retry_started", {
      error: firstError instanceof Error ? firstError.message : String(firstError),
    });

    try {
      await delay(2000);
      return await runInlineVideoFactCheck(requestId, parsedBody, abortSignal);
    } catch (secondError) {
      logEvent(requestId, "video_fact_check_fallback_to_transcript", {
        error: secondError instanceof Error ? secondError.message : String(secondError),
      });

      if (!cohereApiKey) {
        throw secondError;
      }

      return runTranscriptFactCheck(requestId, parsedBody, abortSignal);
    }
  }
}

async function runInlineVideoFactCheck(
  requestId: string,
  parsedBody: ParsedFactCheckRequest,
  abortSignal?: AbortSignal,
): Promise<import("../types").FactCheckResponse> {
  const geminiSettings = getGeminiSettings(parsedBody);
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
    geminiSettings,
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
    promptPreview: truncate(finalPrompt, logPreviewLimits.prompt),
    responseMimeType: "text/plain",
    thinkingLevel: geminiSettings.thinkingLevel,
    geminiModel: geminiSettings.models.finalAnswer,
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
      model: geminiSettings.models.finalAnswer,
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
          thinkingLevel: geminiSettings.thinkingLevel,
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

  return buildResponse(requestId, parsedBody, analysis, reasoning, searchPlan, searchResults, buildGeminiUsage(response), warnings, {
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
  const geminiSettings = getGeminiSettings(parsedBody);
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
    geminiSettings,
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
    promptPreview: truncate(finalPrompt, logPreviewLimits.prompt),
    responseMimeType: "text/plain",
    thinkingLevel: geminiSettings.thinkingLevel,
    geminiModel: geminiSettings.models.finalAnswer,
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
      model: geminiSettings.models.finalAnswer,
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
          thinkingLevel: geminiSettings.thinkingLevel,
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

  return buildResponse(requestId, parsedBody, analysis, reasoning, searchPlan, searchResults, buildGeminiUsage(response), warnings, {
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

async function runOpenAiTranscriptFactCheck(
  requestId: string,
  parsedBody: Extract<ParsedFactCheckRequest, { inputMode: "url" }>,
  abortSignal?: AbortSignal,
): Promise<import("../types").FactCheckResponse> {
  const settings = getOpenAiSettings(parsedBody);
  const audioInput = await downloadAudioForTranscription(requestId, {
    downloadMode: "audio",
    iosCompatible: parsedBody.iosCompatible,
    proxy: parsedBody.proxy,
    quality: parsedBody.quality,
    url: parsedBody.url,
  }, abortSignal);

  const transcript = await transcribeAudioWithCohere(requestId, audioInput, abortSignal);

  const searchPlan = await createOpenAiTranscriptSearchPlan(
    requestId,
    transcript,
    parsedBody.url,
    parsedBody.additionalContext,
    settings,
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

  logEvent(requestId, "openai_request_prepared", {
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
    promptPreview: truncate(finalPrompt, logPreviewLimits.prompt),
    responseMimeType: "text/plain",
    openAiModel: settings.models.finalAnswer,
    provider: "openai",
    exaSearchEnabled: true,
    exaSearchType: parsedBody.searchType,
    exaSearchQueryActualCount: searchPlan.searches.length,
    exaSearchResultCount: searchResults.length,
    transcriptMode: true,
  });

  const response = await generateOpenAiAnalysis(
    requestId,
    "final_answer",
    settings,
    finalPrompt,
    buildSystemInstruction("transcript"),
    abortSignal,
  );

  const analysis = extractOpenAiText(response);

  if (!analysis) {
    throw new HttpError(502, "OpenAI returned an empty response.");
  }

  const warnings = buildWarnings(
    searchPlan.searches,
    searchResults,
    youtubeMaxSearches,
    true,
  );

  return buildResponse(requestId, parsedBody, analysis, null, searchPlan, searchResults, buildOpenAiUsage(response), warnings, {
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
  const geminiSettings = getGeminiSettings(parsedBody);
  const webpage = await getExaWebpageContent(requestId, parsedBody.url, abortSignal);
  const searchPlan = await createWebpageSearchPlan(
    requestId,
    webpage,
    parsedBody.additionalContext,
    geminiSettings,
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
    promptPreview: truncate(finalPrompt, logPreviewLimits.prompt),
    responseMimeType: "text/plain",
    thinkingLevel: geminiSettings.thinkingLevel,
    geminiModel: geminiSettings.models.finalAnswer,
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
      model: geminiSettings.models.finalAnswer,
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
          thinkingLevel: geminiSettings.thinkingLevel,
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

  return buildResponse(requestId, parsedBody, analysis, reasoning, searchPlan, searchResults, buildGeminiUsage(response), warnings, {
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

async function runOpenAiWebpageFactCheck(
  requestId: string,
  parsedBody: Extract<ParsedFactCheckRequest, { inputMode: "url" }>,
  abortSignal?: AbortSignal,
): Promise<import("../types").FactCheckResponse> {
  const settings = getOpenAiSettings(parsedBody);
  const webpage = await getExaWebpageContent(requestId, parsedBody.url, abortSignal);
  const searchPlan = await createOpenAiWebpageSearchPlan(
    requestId,
    webpage,
    parsedBody.additionalContext,
    settings,
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

  logEvent(requestId, "openai_request_prepared", {
    inputMode: "url",
    urlMode: "webpage",
    sourceUrl: parsedBody.url,
    webpageUrl: webpage.url,
    webpageTitle: webpage.title,
    webpageCharacters: webpage.text.length,
    webpageTruncated: webpage.truncated,
    systemInstructionPreview: truncate(buildSystemInstruction("webpage"), 300),
    promptPreview: truncate(finalPrompt, logPreviewLimits.prompt),
    responseMimeType: "text/plain",
    openAiModel: settings.models.finalAnswer,
    provider: "openai",
    exaSearchEnabled: true,
    exaSearchType: parsedBody.searchType,
    exaSearchQueryActualCount: searchPlan.searches.length,
    exaSearchResultCount: searchResults.length,
  });

  const response = await generateOpenAiAnalysis(
    requestId,
    "final_answer",
    settings,
    finalPrompt,
    buildSystemInstruction("webpage"),
    abortSignal,
  );

  const analysis = extractOpenAiText(response);

  if (!analysis) {
    throw new HttpError(502, "OpenAI returned an empty response.");
  }

  const warnings = buildWarnings(
    searchPlan.searches,
    searchResults,
    articleMaxSearches,
    true,
  );

  if (webpage.truncated) {
    warnings.push(
      `Exa returned more article text than EXA_SEARCH_TEXT_MAX_CHARACTERS (${exaTextMaxCharacters}); the article was truncated before OpenAI analysis.`,
    );
  }

  return buildResponse(requestId, parsedBody, analysis, null, searchPlan, searchResults, buildOpenAiUsage(response), warnings, {
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

function getOpenAiSettings(
  parsedBody: Extract<ParsedFactCheckRequest, { inputMode: "url" }>,
): OpenAiRequestSettings {
  if (parsedBody.provider !== "openai") {
    throw new HttpError(500, "Expected an OpenAI fact-check request.");
  }

  return {
    provider: "openai",
    models: {
      searchPlan: parsedBody.models.searchPlan as OpenAiRequestSettings["models"]["searchPlan"],
      finalAnswer: parsedBody.models.finalAnswer as OpenAiRequestSettings["models"]["finalAnswer"],
    },
    effort: parsedBody.effort,
    thinkingLevel: null,
  };
}

function getGeminiSettings(parsedBody: ParsedFactCheckRequest): GeminiRequestSettings {
  if (parsedBody.provider !== "google" || parsedBody.thinkingLevel === null) {
    throw new HttpError(500, "Expected a Gemini fact-check request.");
  }

  return {
    provider: "google",
    models: {
      searchPlan: parsedBody.models.searchPlan as GeminiRequestSettings["models"]["searchPlan"],
      finalAnswer: parsedBody.models.finalAnswer as GeminiRequestSettings["models"]["finalAnswer"],
    },
    effort: parsedBody.effort,
    thinkingLevel: parsedBody.thinkingLevel,
  };
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
    const settings = resolveFactCheckSettings(
      data.provider,
      data.resolvedModel,
      data.effort,
    );

    const urlMode = resolveUrlProcessingMode(
      data.parsedUrl,
      data.sourceType,
      data.speed,
    );
    const speed = data.speed ?? null;

    if (
      settings.provider === "openai" &&
      urlMode !== "webpage" &&
      data.speed !== "fast"
    ) {
      throw new Error(
        "OpenAI provider only supports speed: fast for video URLs because OpenAI models cannot ingest videos directly.",
      );
    }

    return {
      additionalContext:
        data.additionalContext?.trim() ? data.additionalContext.trim() : null,
      speed,
      inputMode: "url",
      iosCompatible: data.iosCompatible,
      mode: data.mode as "direct" | "queue",
      models: settings.models,
      provider: settings.provider,
      proxy: data.proxy,
      quality: data.quality,
      effort: settings.effort,
      searchType: data.searchType as import("../types").ExaSearchType,
      thinkingLevel: settings.thinkingLevel,
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
  const providerEntry = formData.get("provider");
  const legacyReasoningEffortEntry = formData.get("reasoningEffort");
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

  if (legacyReasoningEffortEntry !== null) {
    return {
      error: "The reasoningEffort field is not supported. Use effort.",
      status: 400,
    };
  }

  const provider =
    typeof providerEntry === "string" && providerEntry.trim()
      ? providerEntry.trim().toLowerCase()
      : "openai";
  if (provider === "openai") {
    return {
      error:
        "OpenAI provider cannot fact-check uploaded video files because OpenAI models cannot ingest videos directly. Set provider to google or gemini for file uploads.",
      status: 400,
    };
  }
  if (provider !== "google" && provider !== "gemini") {
    return {
      error: "The provider field must be one of: google, gemini, openai.",
      status: 400,
    };
  }

  const effort =
    typeof effortEntry === "string" && effortEntry.trim()
      ? effortEntry.trim()
      : undefined;

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

    geminiSettings = resolveGeminiSettings(rawModel, effort);
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
    provider: "google",
    effort: geminiSettings.effort,
    searchType: resolvedSearchType as import("../types").ExaSearchType,
    sizeBytes: bytes.byteLength,
    thinkingLevel: geminiSettings.thinkingLevel,
    url: sourceUrl,
  };
}
