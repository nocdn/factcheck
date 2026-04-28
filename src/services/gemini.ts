import { GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import {
  geminiApiKey,
  geminiHighDemandRetryCount,
  geminiHighDemandRetryDelayMs,
  geminiStepDelayMs,
  geminiTimeoutMs,
  searchPlanMaxOutputTokens,
} from "../config";
import {
  buildSearchPlannerSystemInstruction,
  buildSearchPlanningPrompt,
  parseSearchPlan,
} from "../prompts/planning";
import { factCheckJobs } from "../store";
import type {
  GeminiGenerateContentRequest,
  GeminiRequestSettings,
  InlineVideoInput,
  SearchPlan,
} from "../types";
import { HttpError, isGeminiHighDemandError } from "../utils/errors";
import { combineAbortSignals, delay } from "../utils/helpers";
import { logEvent, truncate } from "../utils/logging";

export const ai = geminiApiKey
  ? new GoogleGenAI({ apiKey: geminiApiKey })
  : null;

export type GeminiGenerateContentResponse = Awaited<
  ReturnType<GoogleGenAI["models"]["generateContent"]>
>;

export async function delayBeforeGeminiStep(
  requestId: string,
  step: string,
): Promise<void> {
  if (geminiStepDelayMs <= 0) {
    return;
  }

  logEvent(requestId, "gemini_step_delay_started", {
    delayMs: geminiStepDelayMs,
    step,
  });
  await delay(geminiStepDelayMs);
}

export async function generateGeminiContentWithRetry(
  requestId: string,
  step: string,
  request: GeminiGenerateContentRequest,
): Promise<GeminiGenerateContentResponse> {
  for (let attempt = 0; attempt <= geminiHighDemandRetryCount; attempt += 1) {
    try {
      const timeoutSignal = AbortSignal.timeout(geminiTimeoutMs);
      const mergedSignal = combineAbortSignals(
        request.config?.abortSignal,
        timeoutSignal,
      );

      return await ai!.models.generateContent({
        ...request,
        config: {
          ...request.config,
          abortSignal: mergedSignal ?? timeoutSignal,
        },
      });
    } catch (error) {
      if (!isGeminiHighDemandError(error)) {
        throw error;
      }

      if (attempt >= geminiHighDemandRetryCount) {
        throw new HttpError(
          503,
          `Gemini is currently experiencing high demand. Retried ${geminiHighDemandRetryCount} ${geminiHighDemandRetryCount === 1 ? "time" : "times"} and the model is still unavailable. Please try again later.`,
        );
      }

      logEvent(requestId, "gemini_high_demand_retry_scheduled", {
        attempt: attempt + 1,
        delayMs: geminiHighDemandRetryDelayMs,
        maxRetries: geminiHighDemandRetryCount,
        step,
      });
      await delay(geminiHighDemandRetryDelayMs);
    }
  }

  throw new HttpError(
    503,
    "Gemini is currently unavailable. Please try again later.",
  );
}

function logSearchPlanCompleted(
  requestId: string,
  response: GeminiGenerateContentResponse,
  plan: SearchPlan,
  extra?: Record<string, unknown>,
): void {
  logEvent(requestId, "search_plan_completed", {
    responseId: response.responseId ?? null,
    modelVersion: response.modelVersion ?? null,
    finishReason: response.candidates?.[0]?.finishReason ?? null,
    finishMessage: response.candidates?.[0]?.finishMessage ?? null,
    promptTokenCount: response.usageMetadata?.promptTokenCount ?? null,
    candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
    thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount ?? null,
    totalTokenCount: response.usageMetadata?.totalTokenCount ?? null,
    searches: plan.searches,
    ...extra,
  });
}

export async function createSearchPlan(
  requestId: string,
  videoInput: InlineVideoInput,
  prompt: string,
  geminiSettings: GeminiRequestSettings,
  maxQueries: number,
  clientSignal?: AbortSignal,
): Promise<SearchPlan> {
  logEvent(requestId, "search_plan_started", {
    maxQueries,
    mimeType: videoInput.mimeType,
    sizeBytes: videoInput.sizeBytes,
    model: geminiSettings.models.searchPlan,
    reasoningEffort: geminiSettings.reasoningEffort,
    thinkingLevel: geminiSettings.thinkingLevel,
  });

  const response = await generateGeminiContentWithRetry(
    requestId,
    "search_plan",
    {
      model: geminiSettings.models.searchPlan,
      contents: [
        {
          inlineData: {
            mimeType: videoInput.mimeType,
            data: Buffer.from(videoInput.bytes).toString("base64"),
          },
        },
        {
          text: buildSearchPlanningPrompt("video", maxQueries, {
            embeddedPrompt: prompt,
          }),
        },
      ],
      config: {
        abortSignal: clientSignal,
        maxOutputTokens: searchPlanMaxOutputTokens,
        responseMimeType: "application/json",
        systemInstruction: buildSearchPlannerSystemInstruction("video"),
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: geminiSettings.thinkingLevel,
        },
      },
    },
  );

  const plan = parseSearchPlan(response.text ?? "", maxQueries);

  if (!plan.searches.length) {
    throw new HttpError(502, "Gemini did not produce any Exa search queries.");
  }

  logSearchPlanCompleted(requestId, response, plan);

  return plan;
}

export async function createTranscriptSearchPlan(
  requestId: string,
  transcript: string,
  url: string | null,
  additionalContext: string | null,
  geminiSettings: GeminiRequestSettings,
  maxQueries: number,
  clientSignal?: AbortSignal,
): Promise<SearchPlan> {
  logEvent(requestId, "search_plan_started", {
    transcriptCharacters: transcript.length,
    maxQueries,
    model: geminiSettings.models.searchPlan,
    reasoningEffort: geminiSettings.reasoningEffort,
    thinkingLevel: geminiSettings.thinkingLevel,
    transcriptMode: true,
  });

  const response = await generateGeminiContentWithRetry(
    requestId,
    "search_plan",
    {
      model: geminiSettings.models.searchPlan,
      contents: [
        {
          text: buildSearchPlanningPrompt("transcript", maxQueries, {
            url,
            additionalContext,
            transcript,
          }),
        },
      ],
      config: {
        abortSignal: clientSignal,
        maxOutputTokens: searchPlanMaxOutputTokens,
        responseMimeType: "application/json",
        systemInstruction: buildSearchPlannerSystemInstruction("transcript"),
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: geminiSettings.thinkingLevel,
        },
      },
    },
  );

  const plan = parseSearchPlan(response.text ?? "", maxQueries);

  if (!plan.searches.length) {
    throw new HttpError(502, "Gemini did not produce any Exa search queries.");
  }

  logSearchPlanCompleted(requestId, response, plan, { transcriptMode: true });

  return plan;
}

export async function createWebpageSearchPlan(
  requestId: string,
  webpage: {
    author: string | null;
    publishedDate: string | null;
    query: string;
    text: string;
    title: string | null;
    url: string;
    truncated: boolean;
  },
  additionalContext: string | null,
  geminiSettings: GeminiRequestSettings,
  maxQueries: number,
  clientSignal?: AbortSignal,
): Promise<SearchPlan> {
  logEvent(requestId, "search_plan_started", {
    maxQueries,
    webpageUrl: webpage.url,
    webpageTitle: webpage.title,
    webpageCharacters: webpage.text.length,
    model: geminiSettings.models.searchPlan,
    reasoningEffort: geminiSettings.reasoningEffort,
    thinkingLevel: geminiSettings.thinkingLevel,
    webpageMode: true,
  });

  const response = await generateGeminiContentWithRetry(
    requestId,
    "search_plan",
    {
      model: geminiSettings.models.searchPlan,
      contents: [
        {
          text: buildSearchPlanningPrompt("webpage", maxQueries, {
            additionalContext,
            webpage,
          }),
        },
      ],
      config: {
        abortSignal: clientSignal,
        maxOutputTokens: searchPlanMaxOutputTokens,
        responseMimeType: "application/json",
        systemInstruction: buildSearchPlannerSystemInstruction("webpage"),
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: geminiSettings.thinkingLevel,
        },
      },
    },
  );

  const plan = parseSearchPlan(response.text ?? "", maxQueries);

  if (!plan.searches.length) {
    throw new HttpError(502, "Gemini did not produce any Exa search queries.");
  }

  logSearchPlanCompleted(requestId, response, plan, { webpageMode: true });

  return plan;
}

export function extractThoughtText(parts: Part[] | undefined): string | null {
  const thoughts = (parts ?? [])
    .filter(
      (part) =>
        part.thought && typeof part.text === "string" && part.text.trim(),
    )
    .map((part) => part.text!.trim());

  if (!thoughts.length) {
    return null;
  }

  return thoughts.join("\n\n");
}
