import {
  factCheckMaxOutputTokens,
  openAiApiKey,
  openAiTimeoutMs,
  searchPlanMaxOutputTokens,
} from "../config";
import {
  buildSearchPlannerSystemInstruction,
  buildSearchPlanningPrompt,
  parseSearchPlan,
} from "../prompts/planning";
import type {
  FactCheckMode,
  OpenAiRequestSettings,
  SearchPlan,
} from "../types";
import { HttpError, throwIfNotOk } from "../utils/errors";
import { combineAbortSignals } from "../utils/helpers";
import { logEvent, logPreviewLimits, truncate } from "../utils/logging";

const openAiResponsesUrl = "https://api.openai.com/v1/responses";

export type OpenAiResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  total_tokens?: number;
};

export type OpenAiResponsesResponse = {
  error?: {
    message?: string;
  };
  id?: string;
  incomplete_details?: {
    reason?: string;
  } | null;
  model?: string;
  output?: unknown[];
  output_text?: string;
  status?: string;
  usage?: OpenAiResponsesUsage;
};

type GenerateOpenAiTextRequest = {
  abortSignal?: AbortSignal;
  input: string;
  instructions: string;
  maxOutputTokens?: number;
  model: string;
  effort: string;
};

export async function createOpenAiTranscriptSearchPlan(
  requestId: string,
  transcript: string,
  url: string | null,
  additionalContext: string | null,
  settings: OpenAiRequestSettings,
  maxQueries: number,
  clientSignal?: AbortSignal,
): Promise<SearchPlan> {
  return createOpenAiSearchPlan(
    requestId,
    "transcript",
    buildSearchPlanningPrompt("transcript", maxQueries, {
      url,
      additionalContext,
      transcript,
    }),
    settings,
    maxQueries,
    clientSignal,
  );
}

export async function createOpenAiWebpageSearchPlan(
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
  settings: OpenAiRequestSettings,
  maxQueries: number,
  clientSignal?: AbortSignal,
): Promise<SearchPlan> {
  return createOpenAiSearchPlan(
    requestId,
    "webpage",
    buildSearchPlanningPrompt("webpage", maxQueries, {
      additionalContext,
      webpage,
    }),
    settings,
    maxQueries,
    clientSignal,
  );
}

async function createOpenAiSearchPlan(
  requestId: string,
  mode: Extract<FactCheckMode, "transcript" | "webpage">,
  input: string,
  settings: OpenAiRequestSettings,
  maxQueries: number,
  clientSignal?: AbortSignal,
): Promise<SearchPlan> {
  logEvent(requestId, "search_plan_started", {
    maxQueries,
    model: settings.models.searchPlan,
    provider: "openai",
    effort: settings.effort,
    transcriptMode: mode === "transcript",
    webpageMode: mode === "webpage",
  });

  const response = await generateOpenAiText(requestId, "search_plan", {
    abortSignal: clientSignal,
    input,
    instructions: buildSearchPlannerSystemInstruction(mode),
    maxOutputTokens: searchPlanMaxOutputTokens,
    model: settings.models.searchPlan,
    effort: settings.effort,
  });

  const text = extractOpenAiText(response);
  const plan = parseSearchPlan(text, maxQueries);

  if (!plan.searches.length) {
    throw new HttpError(502, "OpenAI did not produce any Exa search queries.");
  }

  logEvent(requestId, "search_plan_completed", {
    responseId: response.id ?? null,
    modelVersion: response.model ?? null,
    promptTokenCount: response.usage?.input_tokens ?? null,
    candidatesTokenCount: response.usage?.output_tokens ?? null,
    thoughtsTokenCount:
      response.usage?.output_tokens_details?.reasoning_tokens ?? null,
    totalTokenCount: response.usage?.total_tokens ?? null,
    searches: plan.searches,
    provider: "openai",
    transcriptMode: mode === "transcript",
    webpageMode: mode === "webpage",
  });

  return plan;
}

export async function generateOpenAiAnalysis(
  requestId: string,
  step: string,
  settings: OpenAiRequestSettings,
  input: string,
  instructions: string,
  abortSignal?: AbortSignal,
): Promise<OpenAiResponsesResponse> {
  return generateOpenAiText(requestId, step, {
    abortSignal,
    input,
    instructions,
    maxOutputTokens: factCheckMaxOutputTokens,
    model: settings.models.finalAnswer,
    effort: settings.effort,
  });
}

async function generateOpenAiText(
  requestId: string,
  step: string,
  request: GenerateOpenAiTextRequest,
): Promise<OpenAiResponsesResponse> {
  const timeoutSignal = AbortSignal.timeout(openAiTimeoutMs);
  const signal = combineAbortSignals(request.abortSignal, timeoutSignal);

  const response = await fetch(openAiResponsesUrl, {
    body: JSON.stringify({
      input: request.input,
      instructions: request.instructions,
      max_output_tokens: request.maxOutputTokens,
      model: request.model,
      reasoning: {
        effort: request.effort,
      },
    }),
    headers: {
      authorization: `Bearer ${openAiApiKey}`,
      "content-type": "application/json",
      "x-client-request-id": requestId,
    },
    method: "POST",
    signal,
  });

  await throwIfNotOk(response, "OpenAI");

  const body = (await response.json()) as OpenAiResponsesResponse;

  if (body.error?.message) {
    throw new HttpError(502, `OpenAI failed. ${body.error.message}`);
  }

  if (body.status === "incomplete") {
    throw new HttpError(
      502,
      `OpenAI returned an incomplete response.${body.incomplete_details?.reason ? ` Reason: ${body.incomplete_details.reason}.` : ""}`,
    );
  }

  logEvent(requestId, "openai_response_received", {
    responseId: body.id ?? null,
    modelVersion: body.model ?? null,
    outputPreview: truncate(
      extractOpenAiText(body),
      logPreviewLimits.modelResponse,
    ),
    promptTokenCount: body.usage?.input_tokens ?? null,
    candidatesTokenCount: body.usage?.output_tokens ?? null,
    thoughtsTokenCount:
      body.usage?.output_tokens_details?.reasoning_tokens ?? null,
    totalTokenCount: body.usage?.total_tokens ?? null,
    step,
  });

  return body;
}

export function extractOpenAiText(response: OpenAiResponsesResponse): string {
  if (typeof response.output_text === "string") {
    return response.output_text.trim();
  }

  const chunks: string[] = [];
  collectText(response.output, chunks);
  return chunks.join("\n").trim();
}

function collectText(value: unknown, chunks: string[]): void {
  if (typeof value === "string") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, chunks);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (
    (value.type === "output_text" || value.type === "text") &&
    typeof value.text === "string"
  ) {
    chunks.push(value.text);
    return;
  }

  collectText(value.content, chunks);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
