import { ThinkingLevel } from "@google/genai";
import {
  supportedGeminiModels,
  supportedReasoningEfforts,
  type ExaSearchType,
  type GeminiRequestSettings,
  type ReasoningEffort,
  type SupportedGeminiModel,
} from "./types";

export const defaultPort = 7110;
export const port = parseIntegerEnv("PORT", defaultPort);

export const mainWindowMs = parseIntegerEnv(
  "RATE_LIMIT_WINDOW_MS",
  24 * 60 * 60 * 1000,
);
export const mainLimit = parseIntegerEnv("RATE_LIMIT_MAX", 20);
export const healthWindowMs = parseIntegerEnv(
  "HEALTH_RATE_LIMIT_WINDOW_MS",
  500,
);
export const healthLimit = parseIntegerEnv("HEALTH_RATE_LIMIT_MAX", 1);

export const videoDownloadApiUrl =
  process.env.VIDEO_DOWNLOAD_API_URL?.trim() ||
  "https://videos.bartoszbak.org/api/download";
export const geminiApiKey =
  process.env.GEMINI_API_KEY?.trim() ||
  process.env.GOOGLE_API_KEY?.trim() ||
  "";
export const exaApiKey = process.env.EXA_API_KEY?.trim() || "";

export const supportedExaSearchTypes: readonly ExaSearchType[] = [
  "auto",
  "neural",
  "fast",
  "deep-lite",
  "deep",
  "deep-reasoning",
  "instant",
];

export const exaSearchTypeAliases: Record<string, ExaSearchType> = {
  instant: "instant",
  deep: "deep",
  reasoning: "deep-reasoning",
};

export const defaultExaSearchType = resolveExaSearchType(
  process.env.EXA_SEARCH_TYPE,
  "auto",
);
export const socialsMaxSearches = parseBoundedIntegerEnv(
  "SOCIALS_MAX_SEARCHES",
  5,
  1,
  10,
);
export const socialsResultsPerSearch = parseBoundedIntegerEnv(
  "SOCIALS_RESULTS_PER_SEARCH",
  5,
  1,
  10,
);
export const youtubeMaxSearches = parseBoundedIntegerEnv(
  "YOUTUBE_MAX_SEARCHES",
  10,
  1,
  20,
);
export const youtubeResultsPerSearch = parseBoundedIntegerEnv(
  "YOUTUBE_RESULTS_PER_SEARCH",
  3,
  1,
  10,
);
export const articleMaxSearches = parseBoundedIntegerEnv(
  "ARTICLE_MAX_SEARCHES",
  7,
  1,
  10,
);
export const articleResultsPerSearch = parseBoundedIntegerEnv(
  "ARTICLE_RESULTS_PER_SEARCH",
  4,
  1,
  10,
);
export const youtubeAudioQuality =
  process.env.YOUTUBE_AUDIO_QUALITY?.trim() || "low";
export const exaTextMaxCharacters = parseIntegerEnv(
  "EXA_SEARCH_TEXT_MAX_CHARACTERS",
  35_000,
);
export const exaTimeoutMs = parseIntegerEnv("EXA_SEARCH_TIMEOUT_MS", 60_000);
export const factCheckDownloadQuality =
  process.env.FACT_CHECK_DEFAULT_QUALITY?.trim() || "1080p";
export const inlineVideoMaxBytes = parseIntegerEnv(
  "INLINE_VIDEO_MAX_BYTES",
  18 * 1024 * 1024,
);
export const youtubeAudioMaxBytes = parseIntegerEnv(
  "YOUTUBE_AUDIO_MAX_BYTES",
  25 * 1024 * 1024,
);
export const downloadTimeoutMs = parseIntegerEnv(
  "VIDEO_DOWNLOAD_TIMEOUT_MS",
  120_000,
);
export const cohereApiKey = process.env.COHERE_API_KEY?.trim() || "";
export const cohereTranscribeModel =
  process.env.COHERE_TRANSCRIBE_MODEL?.trim() || "cohere-transcribe-03-2026";
export const cohereTranscribeLanguage =
  process.env.COHERE_TRANSCRIBE_LANGUAGE?.trim() || "en";
export const cohereTranscribeTimeoutMs = parseIntegerEnv(
  "COHERE_TRANSCRIBE_TIMEOUT_MS",
  300_000,
);
export const geminiTimeoutMs = parseIntegerEnv("GEMINI_TIMEOUT_MS", 300_000);
export const geminiStepDelayMs = parseNonNegativeIntegerEnv(
  "GEMINI_STEP_DELAY_MS",
  10_000,
);
export const geminiHighDemandRetryCount = parseNonNegativeIntegerEnv(
  "GEMINI_HIGH_DEMAND_RETRY_COUNT",
  2,
);
export const geminiHighDemandRetryDelayMs = parseNonNegativeIntegerEnv(
  "GEMINI_HIGH_DEMAND_RETRY_DELAY_MS",
  10_000,
);

export const exaRetryCount = parseNonNegativeIntegerEnv("EXA_RETRY_COUNT", 2);
export const exaRetryDelayMs = parseNonNegativeIntegerEnv(
  "EXA_RETRY_DELAY_MS",
  5_000,
);
export const downloaderRetryCount = parseNonNegativeIntegerEnv(
  "DOWNLOADER_RETRY_COUNT",
  2,
);
export const downloaderRetryDelayMs = parseNonNegativeIntegerEnv(
  "DOWNLOADER_RETRY_DELAY_MS",
  5_000,
);

export const directModeTimeoutMs = parseIntegerEnv(
  "DIRECT_MODE_TIMEOUT_MS",
  600_000,
);

export const cohereRetryCount = parseNonNegativeIntegerEnv(
  "COHERE_RETRY_COUNT",
  2,
);
export const cohereRetryDelayMs = parseNonNegativeIntegerEnv(
  "COHERE_RETRY_DELAY_MS",
  5_000,
);
export const factCheckMaxOutputTokens = parseIntegerEnv(
  "FACT_CHECK_MAX_OUTPUT_TOKENS",
  32_768,
);
export const searchPlanMaxOutputTokens = parseIntegerEnv(
  "FACT_CHECK_SEARCH_PLAN_MAX_OUTPUT_TOKENS",
  2_048,
);
export const defaultGeminiModel =
  process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview";
export const defaultReasoningEffort =
  process.env.REASONING_EFFORT?.trim().toLowerCase() || "high";

export const supportedQualities = new Set([
  "best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
]);

export const supportedReasoningEffortsByModel: Record<
  SupportedGeminiModel,
  readonly ReasoningEffort[]
> = {
  "gemini-3-flash-preview": supportedReasoningEfforts,
  "gemini-3.1-flash-lite-preview": supportedReasoningEfforts,
};

export const thinkingLevelByReasoningEffort: Record<
  ReasoningEffort,
  ThinkingLevel
> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export const defaultGeminiSettings = resolveGeminiSettings(
  defaultGeminiModel,
  defaultReasoningEffort,
);

export function parseIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function parseNonNegativeIntegerEnv(
  name: string,
  fallback: number,
): number {
  return Math.max(0, parseIntegerEnv(name, fallback));
}

export function parseBoundedIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = parseIntegerEnv(name, fallback);
  return Math.min(Math.max(value, minimum), maximum);
}

export function resolveExaSearchType(
  raw: string | undefined,
  fallback: ExaSearchType,
): ExaSearchType {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (exaSearchTypeAliases[normalized]) return exaSearchTypeAliases[normalized];
  if ((supportedExaSearchTypes as readonly string[]).includes(normalized))
    return normalized as ExaSearchType;
  return fallback;
}

export function resolveGeminiSettings(
  rawModel:
    | SupportedGeminiModel
    | [SupportedGeminiModel, SupportedGeminiModel]
    | string
    | string[],
  rawReasoningEffort: string,
): GeminiRequestSettings {
  if (!isReasoningEffort(rawReasoningEffort)) {
    throw new Error(
      `The reasoningEffort field must be one of: ${supportedReasoningEfforts.join(", ")}.`,
    );
  }

  const models = resolveGeminiStepModels(rawModel);
  const requestedModels = [models.searchPlan, models.finalAnswer];

  for (const model of requestedModels) {
    const supportedEfforts = supportedReasoningEffortsByModel[model];

    if (!supportedEfforts.includes(rawReasoningEffort)) {
      throw new Error(
        `The reasoningEffort field must be one of: ${supportedEfforts.join(", ")} for model ${model}.`,
      );
    }
  }

  return {
    models,
    reasoningEffort: rawReasoningEffort,
    thinkingLevel: thinkingLevelByReasoningEffort[rawReasoningEffort],
  };
}

export function normalizeRequestedModel(
  rawModel: string | string[] | undefined,
): SupportedGeminiModel | [SupportedGeminiModel, SupportedGeminiModel] {
  if (typeof rawModel === "undefined") {
    return defaultGeminiSettings.models.searchPlan;
  }

  if (typeof rawModel === "string") {
    const model = rawModel.trim();

    if (!model) {
      return defaultGeminiSettings.models.searchPlan;
    }

    if (!isSupportedGeminiModel(model)) {
      throw new Error(
        `The model field must be one of: ${supportedGeminiModels.join(", ")}.`,
      );
    }

    return model;
  }

  if (rawModel.length !== 2) {
    throw new Error(
      "The model array must contain exactly two model IDs: search planning, then final answer.",
    );
  }

  const models = rawModel.map((model) => model.trim());

  for (const model of models) {
    if (!isSupportedGeminiModel(model)) {
      throw new Error(
        `Each model array item must be one of: ${supportedGeminiModels.join(", ")}.`,
      );
    }
  }

  return [models[0] as SupportedGeminiModel, models[1] as SupportedGeminiModel];
}

export function resolveGeminiStepModels(
  rawModel:
    | SupportedGeminiModel
    | [SupportedGeminiModel, SupportedGeminiModel]
    | string
    | string[],
): GeminiRequestSettings["models"] {
  const normalized = normalizeRequestedModel(
    Array.isArray(rawModel) ? rawModel : String(rawModel),
  );

  if (Array.isArray(normalized)) {
    return {
      searchPlan: normalized[0],
      finalAnswer: normalized[1],
    };
  }

  return {
    searchPlan: normalized,
    finalAnswer: normalized,
  };
}

export function isSupportedGeminiModel(
  value: string,
): value is SupportedGeminiModel {
  return supportedGeminiModels.includes(value as SupportedGeminiModel);
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return supportedReasoningEfforts.includes(value as ReasoningEffort);
}
