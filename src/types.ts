import { ThinkingLevel } from "@google/genai";

export type SupportedGeminiModel = (typeof supportedGeminiModels)[number];
export type SupportedOpenAiModel = (typeof supportedOpenAiModels)[number];
export type SupportedFactCheckModel =
  | SupportedGeminiModel
  | SupportedOpenAiModel;
export type ModelProvider = (typeof supportedModelProviders)[number];
export type Effort = (typeof supportedEfforts)[number];

export const supportedModelProviders = ["google", "openai"] as const;

export const supportedGeminiModels = [
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
] as const;

export const supportedOpenAiModels = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
] as const;

export const supportedEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const supportedGeminiEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
] as const;

export const supportedOpenAiEfforts = supportedEfforts;

export type GeminiModels = {
  finalAnswer: SupportedGeminiModel;
  searchPlan: SupportedGeminiModel;
};

export type OpenAiModels = {
  finalAnswer: SupportedOpenAiModel;
  searchPlan: SupportedOpenAiModel;
};

export type FactCheckModels = {
  finalAnswer: SupportedFactCheckModel;
  searchPlan: SupportedFactCheckModel;
};

export type GeminiRequestSettings = {
  provider: "google";
  models: GeminiModels;
  effort: Effort;
  thinkingLevel: ThinkingLevel;
};

export type OpenAiRequestSettings = {
  provider: "openai";
  models: OpenAiModels;
  effort: Effort;
  thinkingLevel: null;
};

export type FactCheckRequestSettings =
  | GeminiRequestSettings
  | OpenAiRequestSettings;

export type RequestMode = "direct" | "queue";
export type Speed = "fast" | "regular";

export type ExaSearchType =
  | "auto"
  | "neural"
  | "fast"
  | "deep-lite"
  | "deep"
  | "deep-reasoning"
  | "instant";

export type DownloadMode = "video" | "audio";
export type UrlProcessingMode = "video" | "transcript" | "webpage";
export type UrlSourceType = "auto" | "video" | "webpage";

export type UrlFactCheckInput = {
  downloadMode: DownloadMode;
  iosCompatible: boolean;
  proxy: boolean;
  quality: string;
  url: string;
};

export type SearchPlan = {
  searches: SearchQuery[];
};

export type SearchQuery = {
  query: string;
  rationale: string | null;
};

export type ExaSearchResult = {
  author?: string | null;
  publishedDate?: string | null;
  text?: string | null;
  title?: string | null;
  url?: string | null;
};

export type ExaSearchResponse = {
  requestId?: string;
  results?: ExaSearchResult[];
  searchType?: string;
};

export type ExaContentsResponse = {
  requestId?: string;
  results?: ExaSearchResult[];
  statuses?: Array<{
    error?: {
      httpStatusCode?: number;
      tag?: string;
    };
    id?: string;
    status?: string;
  }>;
};

export type SearchResultContext = {
  author: string | null;
  publishedDate: string | null;
  query: string;
  text: string;
  title: string | null;
  url: string;
};

export type InlineVideoInput = {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type ParsedFactCheckRequest =
  | {
      additionalContext: string | null;
      speed: Speed | null;
      inputMode: "url";
      iosCompatible: boolean;
      mode: RequestMode;
      models: FactCheckModels;
      provider: ModelProvider;
      proxy: boolean;
      quality: string;
      effort: Effort;
      searchType: ExaSearchType;
      thinkingLevel: ThinkingLevel | null;
      url: string;
      urlMode: UrlProcessingMode;
      useTranscript: boolean;
    }
  | {
      additionalContext: string | null;
      bytes: Uint8Array;
      filename: string;
      inputMode: "file";
      mimeType: string;
      mode: RequestMode;
      models: GeminiModels;
      provider: "google";
      effort: Effort;
      searchType: ExaSearchType;
      sizeBytes: number;
      thinkingLevel: ThinkingLevel;
      url: string | null;
    };

export type FactCheckResponse = {
  id: string;
  inputMode: "url" | "file";
  url: string | null;
  provider: ModelProvider;
  model: SupportedFactCheckModel | [SupportedFactCheckModel, SupportedFactCheckModel];
  models: FactCheckModels;
  effort: Effort;
  analysis: string;
  reasoning: string | null;
  download: {
    apiUrl: string;
    filename: string;
    mimeType: string;
    quality: string;
    requestedQuality: string;
    sizeBytes: number;
    iosCompatible: boolean;
    proxy: boolean;
  } | null;
  uploadedFile: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
  } | null;
  transcription: {
    provider: "cohere";
    model: string;
    language: string;
    characterCount: number;
    audio: {
      apiUrl: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      iosCompatible: boolean;
      proxy: boolean;
    };
  } | null;
  webpage: {
    provider: "exa";
    title: string | null;
    url: string;
    publishedDate: string | null;
    author: string | null;
    characterCount: number;
    truncated: boolean;
  } | null;
  research: {
    provider: "exa";
    searchType: string;
    queries: SearchQuery[];
    results: Array<{
      query: string;
      title: string | null;
      url: string;
      publishedDate: string | null;
      author: string | null;
    }>;
  };
  usage: {
    promptTokenCount: number | null;
    candidatesTokenCount: number | null;
    thoughtsTokenCount: number | null;
    toolUsePromptTokenCount: number | null;
    totalTokenCount: number | null;
  } | null;
  warnings: string[];
};

export type FactCheckJob =
  | {
      createdAt: number;
      status: "processing";
    }
  | {
      createdAt: number;
      completedAt: number;
      result: FactCheckResponse;
      status: "completed";
    }
  | {
      createdAt: number;
      completedAt: number;
      error: string;
      status: "failed";
      statusCode: ErrorStatus;
    };

export type ErrorStatus = 400 | 413 | 429 | 500 | 502 | 503 | 504;

export type FactCheckMode = "video" | "transcript" | "webpage";
