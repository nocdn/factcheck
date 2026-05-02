import { ThinkingLevel } from "@google/genai";
import {
  supportedEfforts,
  supportedGeminiEfforts,
  supportedGeminiModels,
  supportedOpenAiEfforts,
  supportedOpenAiModels,
  type Effort,
  type ExaSearchType,
  type FactCheckRequestSettings,
  type GeminiRequestSettings,
  type ModelProvider,
  type OpenAiRequestSettings,
  type SupportedGeminiModel,
  type SupportedOpenAiModel,
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
export const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || "";
export const exaApiKey = process.env.EXA_API_KEY?.trim() || "";
export const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";

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
export const openAiTimeoutMs = parseIntegerEnv("OPENAI_TIMEOUT_MS", 300_000);
export const providerStepDelayMs = parseNonNegativeIntegerEnv(
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
  "MAX_OUTPUT_TOKENS",
  32_768,
);
export const searchPlanMaxOutputTokens = parseIntegerEnv(
  "SEARCH_PLAN_MAX_OUTPUT_TOKENS",
  2_048,
);
export const defaultGeminiModel =
  process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview";
export const defaultOpenAiModel = process.env.OPENAI_MODEL?.trim() || "gpt-5.5";
export const defaultEffort =
  process.env.EFFORT?.trim().toLowerCase() || "high";
export const defaultOpenAiEffort =
  process.env.OPENAI_EFFORT?.trim().toLowerCase() || "medium";

export const supportedQualities = new Set([
  "best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
]);

export const supportedEffortsByModel: Record<
  SupportedGeminiModel,
  readonly (typeof supportedGeminiEfforts)[number][]
> = {
  "gemini-3-flash-preview": supportedGeminiEfforts,
  "gemini-3.1-flash-lite-preview": supportedGeminiEfforts,
};

export const thinkingLevelByEffort: Record<
  (typeof supportedGeminiEfforts)[number],
  ThinkingLevel
> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export const defaultGeminiSettings = resolveGeminiSettings(
  defaultGeminiModel,
  defaultEffort,
);

export const defaultOpenAiSettings = resolveOpenAiSettings(
  defaultOpenAiModel,
  defaultOpenAiEffort,
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
    | string[]
    | undefined,
  rawEffort: string | undefined,
): GeminiRequestSettings {
  const effort = rawEffort || defaultEffort;

  if (!isGeminiEffort(effort)) {
    throw new Error(
      `The effort field must be one of: ${supportedGeminiEfforts.join(", ")} for Gemini.`,
    );
  }

  const models = resolveGeminiStepModels(rawModel);
  const requestedModels = [models.searchPlan, models.finalAnswer];

  for (const model of requestedModels) {
    const supportedModelEfforts = supportedEffortsByModel[model];

    if (!supportedModelEfforts.includes(effort)) {
      throw new Error(
        `The effort field must be one of: ${supportedModelEfforts.join(", ")} for model ${model}.`,
      );
    }
  }

  return {
    provider: "google",
    models,
    effort,
    thinkingLevel: thinkingLevelByEffort[effort],
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
    | string[]
    | undefined,
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

export function resolveFactCheckSettings(
  provider: ModelProvider,
  rawModel: string | string[] | undefined,
  rawEffort: string | undefined,
): FactCheckRequestSettings {
  if (provider === "openai") {
    return resolveOpenAiSettings(rawModel, rawEffort);
  }

  return resolveGeminiSettings(rawModel, rawEffort);
}

export function resolveOpenAiSettings(
  rawModel:
    | SupportedOpenAiModel
    | [SupportedOpenAiModel, SupportedOpenAiModel]
    | string
    | string[]
    | undefined,
  rawEffort: string | undefined,
): OpenAiRequestSettings {
  const effort = rawEffort || defaultOpenAiEffort;

  if (!isOpenAiEffort(effort)) {
    throw new Error(
      `The effort field must be one of: ${supportedOpenAiEfforts.join(", ")} for OpenAI.`,
    );
  }

  const models = resolveOpenAiStepModels(rawModel);

  for (const model of [models.searchPlan, models.finalAnswer]) {
    const supportedModelEfforts = getSupportedOpenAiEfforts(model);

    if (!supportedModelEfforts.includes(effort)) {
      throw new Error(
        `The effort field must be one of: ${supportedModelEfforts.join(", ")} for model ${model}.`,
      );
    }
  }

  return {
    provider: "openai",
    models,
    effort,
    thinkingLevel: null,
  };
}

function getSupportedOpenAiEfforts(
  model: SupportedOpenAiModel,
): readonly Effort[] {
  if (model === "gpt-5" || model === "gpt-5-mini" || model === "gpt-5-nano") {
    return ["minimal", "low", "medium", "high"];
  }

  return ["none", "low", "medium", "high", "xhigh"];
}

export function resolveOpenAiStepModels(
  rawModel:
    | SupportedOpenAiModel
    | [SupportedOpenAiModel, SupportedOpenAiModel]
    | string
    | string[]
    | undefined,
): OpenAiRequestSettings["models"] {
  const normalized = normalizeRequestedOpenAiModel(rawModel);

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

export function normalizeRequestedOpenAiModel(
  rawModel: string | string[] | undefined,
): SupportedOpenAiModel | [SupportedOpenAiModel, SupportedOpenAiModel] {
  if (typeof rawModel === "undefined") {
    return resolveDefaultOpenAiModel();
  }

  if (typeof rawModel === "string") {
    const model = rawModel.trim();

    if (!model) {
      return resolveDefaultOpenAiModel();
    }

    if (!isSupportedOpenAiModel(model)) {
      throw new Error(
        `The model field must be one of these OpenAI models: ${supportedOpenAiModels.join(", ")}.`,
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
    if (!isSupportedOpenAiModel(model)) {
      throw new Error(
        `Each model array item must be one of these OpenAI models: ${supportedOpenAiModels.join(", ")}.`,
      );
    }
  }

  return [models[0] as SupportedOpenAiModel, models[1] as SupportedOpenAiModel];
}

function resolveDefaultOpenAiModel(): SupportedOpenAiModel {
  if (!isSupportedOpenAiModel(defaultOpenAiModel)) {
    throw new Error(
      `OPENAI_MODEL must be one of: ${supportedOpenAiModels.join(", ")}.`,
    );
  }

  return defaultOpenAiModel;
}

export function isSupportedGeminiModel(
  value: string,
): value is SupportedGeminiModel {
  return supportedGeminiModels.includes(value as SupportedGeminiModel);
}

export function isSupportedOpenAiModel(
  value: string,
): value is SupportedOpenAiModel {
  return supportedOpenAiModels.includes(value as SupportedOpenAiModel);
}

export function isEffort(value: string): value is Effort {
  return supportedEfforts.includes(value as Effort);
}

export function isGeminiEffort(
  value: string,
): value is (typeof supportedGeminiEfforts)[number] {
  return supportedGeminiEfforts.includes(
    value as (typeof supportedGeminiEfforts)[number],
  );
}

export function isOpenAiEffort(value: string): value is Effort {
  return supportedOpenAiEfforts.includes(value as Effort);
}
