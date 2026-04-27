import { GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { rateLimiter } from "hono-rate-limiter";

const defaultPort = 7110;
const port = parseIntegerEnv("PORT", defaultPort);

const mainWindowMs = parseIntegerEnv("RATE_LIMIT_WINDOW_MS", 24 * 60 * 60 * 1000);
const mainLimit = parseIntegerEnv("RATE_LIMIT_MAX", 10);
const healthWindowMs = parseIntegerEnv("HEALTH_RATE_LIMIT_WINDOW_MS", 500);
const healthLimit = parseIntegerEnv("HEALTH_RATE_LIMIT_MAX", 1);

const videoDownloadApiUrl = process.env.VIDEO_DOWNLOAD_API_URL?.trim() || "https://videos.bartoszbak.org/api/download";
const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
const exaApiKey = process.env.EXA_API_KEY?.trim() || "";
const exaSearchType = process.env.EXA_SEARCH_TYPE?.trim() || "auto";
const exaSearchQueryCount = parseBoundedIntegerEnv("EXA_SEARCH_QUERY_COUNT", 3, 1, 10);
const exaResultsPerQuery = parseBoundedIntegerEnv("EXA_SEARCH_RESULTS_PER_QUERY", 6, 1, 10);
const exaTextMaxCharacters = parseIntegerEnv("EXA_SEARCH_TEXT_MAX_CHARACTERS", 35_000);
const exaTimeoutMs = parseIntegerEnv("EXA_SEARCH_TIMEOUT_MS", 60_000);
const factCheckDownloadQuality = process.env.FACT_CHECK_DEFAULT_QUALITY?.trim() || "1080p";
const inlineVideoMaxBytes = parseIntegerEnv("INLINE_VIDEO_MAX_BYTES", 18 * 1024 * 1024);
const downloadTimeoutMs = parseIntegerEnv("VIDEO_DOWNLOAD_TIMEOUT_MS", 120_000);
const geminiTimeoutMs = parseIntegerEnv("GEMINI_TIMEOUT_MS", 300_000);
const geminiStepDelayMs = parseNonNegativeIntegerEnv("GEMINI_STEP_DELAY_MS", 10_000);
const geminiHighDemandRetryCount = parseNonNegativeIntegerEnv("GEMINI_HIGH_DEMAND_RETRY_COUNT", 2);
const geminiHighDemandRetryDelayMs = parseNonNegativeIntegerEnv("GEMINI_HIGH_DEMAND_RETRY_DELAY_MS", 10_000);
const factCheckMaxOutputTokens = parseIntegerEnv("FACT_CHECK_MAX_OUTPUT_TOKENS", 32_768);
const searchPlanMaxOutputTokens = parseIntegerEnv("FACT_CHECK_SEARCH_PLAN_MAX_OUTPUT_TOKENS", 2_048);
const defaultGeminiModel = process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview";
const defaultReasoningEffort = process.env.REASONING_EFFORT?.trim().toLowerCase() || "high";

const supportedQualities = new Set([
  "best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
]);

const supportedGeminiModels = [
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
] as const;

const supportedReasoningEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
] as const;

type SupportedGeminiModel = typeof supportedGeminiModels[number];
type ReasoningEffort = typeof supportedReasoningEfforts[number];

const supportedReasoningEffortsByModel: Record<SupportedGeminiModel, readonly ReasoningEffort[]> = {
  "gemini-3-flash-preview": supportedReasoningEfforts,
  "gemini-3.1-flash-lite-preview": supportedReasoningEfforts,
};

const thinkingLevelByReasoningEffort: Record<ReasoningEffort, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

type GeminiRequestSettings = {
  model: SupportedGeminiModel | [SupportedGeminiModel, SupportedGeminiModel];
  models: {
    finalAnswer: SupportedGeminiModel;
    searchPlan: SupportedGeminiModel;
  };
  reasoningEffort: ReasoningEffort;
  thinkingLevel: ThinkingLevel;
};

const defaultGeminiSettings = resolveGeminiSettings(defaultGeminiModel, defaultReasoningEffort);

type RequestMode = "direct" | "queue";

type UrlFactCheckInput = {
  iosCompatible: boolean;
  proxy: boolean;
  quality: string;
  url: string;
};

type SearchPlan = {
  searches: SearchQuery[];
};

type SearchQuery = {
  query: string;
  rationale: string | null;
};

type ExaSearchResult = {
  author?: string | null;
  publishedDate?: string | null;
  text?: string | null;
  title?: string | null;
  url?: string | null;
};

type ExaSearchResponse = {
  requestId?: string;
  results?: ExaSearchResult[];
  searchType?: string;
};

type SearchResultContext = {
  author: string | null;
  publishedDate: string | null;
  query: string;
  text: string;
  title: string | null;
  url: string;
};

type InlineVideoInput = {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

type ParsedFactCheckRequest =
  | {
      additionalContext: string | null;
      inputMode: "url";
      iosCompatible: boolean;
      mode: RequestMode;
      model: SupportedGeminiModel | [SupportedGeminiModel, SupportedGeminiModel];
      models: GeminiRequestSettings["models"];
      proxy: boolean;
      quality: string;
      reasoningEffort: ReasoningEffort;
      thinkingLevel: ThinkingLevel;
      url: string;
    }
  | {
      additionalContext: string | null;
      bytes: Uint8Array;
      filename: string;
      inputMode: "file";
      mimeType: string;
      mode: RequestMode;
      model: SupportedGeminiModel | [SupportedGeminiModel, SupportedGeminiModel];
      models: GeminiRequestSettings["models"];
      reasoningEffort: ReasoningEffort;
      sizeBytes: number;
      thinkingLevel: ThinkingLevel;
      url: string | null;
    };

type FactCheckResponse = {
  id: string;
  inputMode: "url" | "file";
  url: string | null;
  model: SupportedGeminiModel | [SupportedGeminiModel, SupportedGeminiModel];
  models: GeminiRequestSettings["models"];
  reasoningEffort: ReasoningEffort;
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

type FactCheckJob =
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

const factCheckJobs = new Map<string, FactCheckJob>();

type GeminiGenerateContentRequest = Parameters<GoogleGenAI["models"]["generateContent"]>[0];
type GeminiGenerateContentResponse = Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
type ErrorStatus = 400 | 413 | 429 | 500 | 502 | 503 | 504;

const factCheckSystemInstruction = [
  "You are a meticulous video fact-checking analyst.",
  "Use the provided video as the primary source of claims.",
  "Use the provided Exa search results as supporting evidence.",
  "Compare the video's claims against the search evidence before drawing conclusions.",
  "Assess spoken claims, captions, on-screen text, visible documents, charts, and important visual context.",
  "Do not invent facts, sources, certainty, or quotes.",
  "If evidence is mixed, outdated, or incomplete, say so plainly.",
  "The final fact-check must be plain text only with zero markdown of any kind; that is very important. No bold, no italics, no links in markdown, no backticks, no list markers except the citation format below.",
  "Start the response with a confidence line exactly in this format: Confidence: X/10 where X is a whole number from 1 to 10.",
  "That confidence score must be realistically calibrated to the quality, freshness, and completeness of the evidence. Avoid scores that are overly generous or overly harsh. Use middling scores when the evidence is mixed, incomplete, indirect, old, or somewhat uncertain, and reserve very high or very low confidence only for unusually strong or unusually weak evidence.",
  "After the confidence line, add a blank line, then a line with exactly: Explanation:",
  "Put the full fact-check explanation after Explanation: as plain text paragraphs.",
  "In the main analysis, cite sources using inline bracket numbers only, matching the Sources list at the end. For a single source use [1]. For multiple sources, repeat brackets with no commas or spaces between them, like [1][2][4][9]. Do not use one bracket with commas inside, such as [1, 2, 4, 9]. Use only the numbers 1, 2, and so on that you assign in the final Sources list.",
  "End the response with a final Sources: section: one line per source, in order, exactly like this: [1] - https://example.com/path (then [2] - https://... on the next line, and so on). No other format for that list.",
  "After Sources:, add a final Searches: section listing every Exa search query that was performed, one query per line in order, exactly like this: (1) - query text, then (2) - query text, and so on.",
  "If you cite a source in the text, it must appear in Sources with the same number and URL. Only include URLs you actually use from the Exa search context.",
].join(" ");

const app = new Hono();
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

app.use(logger());

const mainLimiter = rateLimiter({
  windowMs: mainWindowMs,
  limit: mainLimit,
  keyGenerator: () => "global",
});

const healthLimiter = rateLimiter({
  windowMs: healthWindowMs,
  limit: healthLimit,
  keyGenerator: () => "global",
});

app.use("*", async (c, next) => {
  if (c.req.path !== "/api/check") {
    return next();
  }
  return mainLimiter(c, next);
});

app.get("/api/health", healthLimiter, (c) => {
  return c.json({
    status: "ok",
    geminiConfigured: Boolean(geminiApiKey),
    exaConfigured: Boolean(exaApiKey),
    model: defaultGeminiSettings.model,
    models: defaultGeminiSettings.models,
    reasoningEffort: defaultGeminiSettings.reasoningEffort,
  });
});

app.get("/api", (c) => {
  return c.json({
    name: "factcheck",
    status: "ok",
    port,
    routes: ["/api/health", "/api/check", "/api/check/:jobId"],
    model: defaultGeminiSettings.model,
    models: defaultGeminiSettings.models,
    reasoningEffort: defaultGeminiSettings.reasoningEffort,
  });
});

app.get("/api/check/:jobId", (c) => {
  const jobId = c.req.param("jobId");
  const job = factCheckJobs.get(jobId);

  if (!job) {
    return c.json({ error: "Job not found." }, 404);
  }

  if (job.status === "processing") {
    return c.json({ id: jobId, ready: false });
  }

  if (job.status === "failed") {
    return c.json(
      {
        id: jobId,
        ready: true,
        error: job.error,
      },
      job.statusCode,
    );
  }

  return c.json({
    ready: true,
    ...job.result,
  });
});

app.post("/api/check", async (c) => {
  if (!ai) {
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

  const requestId = parsedBody.mode === "queue" ? createJobId() : createRequestId();
  logEvent(requestId, "fact_check_request_received", {
    requestMode: parsedBody.mode,
    inputMode: parsedBody.inputMode,
    url: parsedBody.url,
    filename: parsedBody.inputMode === "file" ? parsedBody.filename : null,
    mimeType: parsedBody.inputMode === "file" ? parsedBody.mimeType : null,
    sizeBytes: parsedBody.inputMode === "file" ? parsedBody.sizeBytes : null,
    quality: parsedBody.inputMode === "url" ? parsedBody.quality : null,
    iosCompatible: parsedBody.inputMode === "url" ? parsedBody.iosCompatible : null,
    proxy: parsedBody.inputMode === "url" ? parsedBody.proxy : null,
    additionalContextLength: parsedBody.additionalContext?.length ?? 0,
    inlineVideoMaxBytes,
    geminiModel: parsedBody.model,
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

  try {
    return c.json(await runFactCheck(requestId, parsedBody));
  } catch (error) {
    console.error(`[fact-check:${requestId}]`, error);
    return handleFactCheckError(error);
  }
});

const server = Bun.serve({
  fetch: app.fetch,
  port,
});

console.log(`Listening on http://localhost:${server.port}`);

async function runQueuedFactCheck(requestId: string, input: ParsedFactCheckRequest): Promise<void> {
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

async function runFactCheck(requestId: string, parsedBody: ParsedFactCheckRequest): Promise<FactCheckResponse> {
  const videoInput = parsedBody.inputMode === "url"
    ? await downloadVideoForInlineUse(requestId, parsedBody)
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

  const prompt = buildFactCheckPrompt(parsedBody.url, parsedBody.additionalContext);
  const searchPlan = await createSearchPlan(requestId, videoInput, prompt, parsedBody);
  const searchResults = await runExaSearches(requestId, searchPlan.searches);
  const searchContext = buildSearchContext(searchResults, searchPlan.searches);
  const finalPrompt = buildFactCheckPrompt(parsedBody.url, parsedBody.additionalContext, searchContext);

  await delayBeforeGeminiStep(requestId, "final_answer");

  logEvent(requestId, "gemini_request_prepared", {
    inputMode: parsedBody.inputMode,
    sourceUrl: parsedBody.url,
    mimeType: videoInput.mimeType,
    sizeBytes: videoInput.sizeBytes,
    filename: videoInput.filename,
    systemInstructionPreview: truncate(factCheckSystemInstruction, 300),
    promptPreview: truncate(finalPrompt, 500),
    responseMimeType: "text/plain",
    thinkingLevel: parsedBody.thinkingLevel,
    geminiModel: parsedBody.models.finalAnswer,
    exaSearchEnabled: true,
    exaSearchQueryCount: searchPlan.searches.length,
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
        abortSignal: AbortSignal.timeout(geminiTimeoutMs),
        maxOutputTokens: factCheckMaxOutputTokens,
        responseMimeType: "text/plain",
        systemInstruction: factCheckSystemInstruction,
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
  const warnings = buildWarnings(searchPlan.searches, searchResults);

  logEvent(requestId, "gemini_response_received", {
    responseId: response.responseId ?? null,
    modelVersion: response.modelVersion ?? null,
    finishReason: candidate?.finishReason ?? null,
    finishMessage: candidate?.finishMessage ?? null,
    promptTokenCount: response.usageMetadata?.promptTokenCount ?? null,
    candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
    thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount ?? null,
    toolUsePromptTokenCount: response.usageMetadata?.toolUsePromptTokenCount ?? null,
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
  });

  return {
    id: requestId,
    inputMode: parsedBody.inputMode,
    url: parsedBody.url,
    model: parsedBody.model,
    models: parsedBody.models,
    reasoningEffort: parsedBody.reasoningEffort,
    analysis,
    reasoning,
    download: parsedBody.inputMode === "url"
      ? {
          apiUrl: videoDownloadApiUrl,
          filename: videoInput.filename,
          mimeType: videoInput.mimeType,
          quality: "quality" in videoInput ? videoInput.quality : parsedBody.quality,
          requestedQuality: parsedBody.quality,
          sizeBytes: videoInput.sizeBytes,
          iosCompatible: parsedBody.iosCompatible,
          proxy: parsedBody.proxy,
        }
      : null,
    uploadedFile: parsedBody.inputMode === "file"
      ? {
          filename: videoInput.filename,
          mimeType: videoInput.mimeType,
          sizeBytes: videoInput.sizeBytes,
        }
      : null,
    research: {
      provider: "exa",
      searchType: exaSearchType,
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
          candidatesTokenCount: response.usageMetadata.candidatesTokenCount ?? null,
          thoughtsTokenCount: response.usageMetadata.thoughtsTokenCount ?? null,
          toolUsePromptTokenCount: response.usageMetadata.toolUsePromptTokenCount ?? null,
          totalTokenCount: response.usageMetadata.totalTokenCount ?? null,
        }
      : null,
    warnings,
  };
}

function parseIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  return Math.max(0, parseIntegerEnv(name, fallback));
}

function parseBoundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = parseIntegerEnv(name, fallback);
  return Math.min(Math.max(value, minimum), maximum);
}

function createRequestId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function createJobId(): string {
  let jobId = "";

  do {
    jobId = crypto.getRandomValues(new Uint32Array(1))[0]!.toString().padStart(10, "0").slice(-8);
  } while (factCheckJobs.has(jobId));

  return jobId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function parseFactCheckRequest(
  request: Request,
): Promise<ParsedFactCheckRequest | { error: string; status: 400 | 413 }> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.startsWith("multipart/form-data")) {
    return parseMultipartFactCheckRequest(request);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return { error: "Request body must be valid JSON.", status: 400 };
  }

  if (!isRecord(body)) {
    return { error: "Request body must be a JSON object.", status: 400 };
  }

  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";

  if (!rawUrl) {
    return { error: "The url field is required.", status: 400 };
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { error: "The url field must be a valid absolute URL.", status: 400 };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return { error: "Only http and https video URLs are supported.", status: 400 };
  }

  const quality = typeof body.quality === "string" && body.quality.trim() ? body.quality.trim() : factCheckDownloadQuality;

  if (!supportedQualities.has(quality)) {
    return {
      error: "The quality field must be one of: best, 2160p, 1440p, 1080p, 720p, 480p, 360p.",
      status: 400,
    };
  }

  if (typeof body.iosCompatible !== "undefined" && typeof body.iosCompatible !== "boolean") {
    return { error: "The iosCompatible field must be a boolean when provided.", status: 400 };
  }

  if (typeof body.proxy !== "undefined" && typeof body.proxy !== "boolean") {
    return { error: "The proxy field must be a boolean when provided.", status: 400 };
  }

  if (typeof body.additionalContext !== "undefined" && typeof body.additionalContext !== "string") {
    return { error: "The additionalContext field must be a string when provided.", status: 400 };
  }

  if (
    typeof body.model !== "undefined"
    && typeof body.model !== "string"
    && !Array.isArray(body.model)
  ) {
    return { error: "The model field must be a string or an array of two strings when provided.", status: 400 };
  }

  if (Array.isArray(body.model) && body.model.some((value) => typeof value !== "string")) {
    return { error: "The model array must contain only strings.", status: 400 };
  }

  if (typeof body.reasoningEffort !== "undefined" && typeof body.reasoningEffort !== "string") {
    return { error: "The reasoningEffort field must be a string when provided.", status: 400 };
  }

  if (typeof body.effort !== "undefined" && typeof body.effort !== "string") {
    return { error: "The effort field must be a string when provided.", status: 400 };
  }

  if (typeof body.mode !== "undefined" && typeof body.mode !== "string") {
    return { error: "The mode field must be a string when provided.", status: 400 };
  }

  const requestMode = parseRequestMode(typeof body.mode === "string" ? body.mode : undefined);

  if ("error" in requestMode) {
    return { error: requestMode.error, status: 400 };
  }

  const rawReasoningEffort = typeof body.reasoningEffort === "string" ? body.reasoningEffort : undefined;
  const rawEffort = typeof body.effort === "string" ? body.effort : undefined;

  if (
    rawReasoningEffort?.trim()
    && rawEffort?.trim()
    && rawReasoningEffort.trim().toLowerCase() !== rawEffort.trim().toLowerCase()
  ) {
    return {
      error: "The reasoningEffort and effort fields must match when both are provided.",
      status: 400,
    };
  }

  const geminiSettings = parseGeminiOverrides(
    typeof body.model === "string" || Array.isArray(body.model) ? body.model : undefined,
    rawReasoningEffort ?? rawEffort,
  );

  if ("error" in geminiSettings) {
    return { error: geminiSettings.error, status: 400 };
  }

  return {
    additionalContext: typeof body.additionalContext === "string" && body.additionalContext.trim()
      ? body.additionalContext.trim()
      : null,
    inputMode: "url",
    iosCompatible: typeof body.iosCompatible === "boolean" ? body.iosCompatible : true,
    mode: requestMode.mode,
    model: geminiSettings.model,
    models: geminiSettings.models,
    proxy: typeof body.proxy === "boolean" ? body.proxy : false,
    quality,
    reasoningEffort: geminiSettings.reasoningEffort,
    thinkingLevel: geminiSettings.thinkingLevel,
    url: parsedUrl.toString(),
  };
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
    return { error: "Multipart requests must include a file field containing the video file.", status: 400 };
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
    return { error: "The uploaded file must have a video MIME type.", status: 400 };
  }

  const sourceUrlEntry = formData.get("url");
  let sourceUrl: string | null = null;

  if (typeof sourceUrlEntry === "string" && sourceUrlEntry.trim()) {
    try {
      const parsedSourceUrl = new URL(sourceUrlEntry.trim());

      if (!["http:", "https:"].includes(parsedSourceUrl.protocol)) {
        return { error: "The optional url field must use http or https.", status: 400 };
      }

      sourceUrl = parsedSourceUrl.toString();
    } catch {
      return { error: "The optional url field must be a valid absolute URL.", status: 400 };
    }
  }

  const additionalContextEntry = formData.get("additionalContext");

  if (additionalContextEntry !== null && typeof additionalContextEntry !== "string") {
    return { error: "The additionalContext field must be a string when provided.", status: 400 };
  }

  const modelEntry = formData.get("model");

  if (modelEntry !== null && typeof modelEntry !== "string") {
    return { error: "The model field must be a string when provided.", status: 400 };
  }

  const reasoningEffortEntry = formData.get("reasoningEffort");

  if (reasoningEffortEntry !== null && typeof reasoningEffortEntry !== "string") {
    return { error: "The reasoningEffort field must be a string when provided.", status: 400 };
  }

  const effortEntry = formData.get("effort");

  if (effortEntry !== null && typeof effortEntry !== "string") {
    return { error: "The effort field must be a string when provided.", status: 400 };
  }

  const modeEntry = formData.get("mode");

  if (modeEntry !== null && typeof modeEntry !== "string") {
    return { error: "The mode field must be a string when provided.", status: 400 };
  }

  const requestMode = parseRequestMode(typeof modeEntry === "string" ? modeEntry : undefined);

  if ("error" in requestMode) {
    return { error: requestMode.error, status: 400 };
  }

  if (
    typeof reasoningEffortEntry === "string"
    && reasoningEffortEntry.trim()
    && typeof effortEntry === "string"
    && effortEntry.trim()
    && reasoningEffortEntry.trim().toLowerCase() !== effortEntry.trim().toLowerCase()
  ) {
    return {
      error: "The reasoningEffort and effort fields must match when both are provided.",
      status: 400,
    };
  }

  const geminiSettings = parseGeminiOverrides(
    parseMultipartModelEntry(modelEntry),
    (typeof reasoningEffortEntry === "string" ? reasoningEffortEntry : undefined)
      ?? (typeof effortEntry === "string" ? effortEntry : undefined),
  );

  if ("error" in geminiSettings) {
    return { error: geminiSettings.error, status: 400 };
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
    additionalContext: typeof additionalContextEntry === "string" && additionalContextEntry.trim()
      ? additionalContextEntry.trim()
      : null,
    bytes,
    filename: fileEntry.name || `${createRequestId()}.mp4`,
    inputMode: "file",
    mimeType,
    mode: requestMode.mode,
    model: geminiSettings.model,
    models: geminiSettings.models,
    reasoningEffort: geminiSettings.reasoningEffort,
    sizeBytes: bytes.byteLength,
    thinkingLevel: geminiSettings.thinkingLevel,
    url: sourceUrl,
  };
}

async function downloadVideoForInlineUse(requestId: string, input: UrlFactCheckInput): Promise<{
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

  let response = await fetchDownloadVideo(input);
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

      response = await fetchDownloadVideo({ ...input, quality: "best" });

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

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new HttpError(
      502,
      `Video download API failed with status ${response.status}.${errorText ? ` ${truncate(errorText, 500)}` : ""}`,
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;

  if (!Number.isNaN(contentLength) && contentLength > inlineVideoMaxBytes) {
    throw new HttpError(
      413,
      `Downloaded video is ${contentLength} bytes, which exceeds INLINE_VIDEO_MAX_BYTES (${inlineVideoMaxBytes}). Lower the quality or raise the limit.`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  if (bytes.byteLength > inlineVideoMaxBytes) {
    throw new HttpError(
      413,
      `Downloaded video is ${bytes.byteLength} bytes, which exceeds INLINE_VIDEO_MAX_BYTES (${inlineVideoMaxBytes}). Lower the quality or raise the limit.`,
    );
  }

  const result = {
    bytes,
    filename: getFilenameFromHeaders(response.headers) || `${createRequestId()}.mp4`,
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

function fetchDownloadVideo(input: UrlFactCheckInput): Promise<Response> {
  return fetch(videoDownloadApiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: input.url,
      quality: input.quality,
      mode: "both",
      iosCompatible: input.iosCompatible,
      proxy: input.proxy,
      playlist: false,
    }),
    signal: AbortSignal.timeout(downloadTimeoutMs),
  });
}

function isUnavailableFormatError(errorText: string): boolean {
  return errorText.toLowerCase().includes("requested format is not available");
}

async function delayBeforeGeminiStep(requestId: string, step: string): Promise<void> {
  if (geminiStepDelayMs <= 0) {
    return;
  }

  logEvent(requestId, "gemini_step_delay_started", {
    delayMs: geminiStepDelayMs,
    step,
  });
  await delay(geminiStepDelayMs);
}

async function generateGeminiContentWithRetry(
  requestId: string,
  step: string,
  request: GeminiGenerateContentRequest,
): Promise<GeminiGenerateContentResponse> {
  for (let attempt = 0; attempt <= geminiHighDemandRetryCount; attempt += 1) {
    try {
      return await ai!.models.generateContent({
        ...request,
        config: {
          ...request.config,
          abortSignal: AbortSignal.timeout(geminiTimeoutMs),
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

  throw new HttpError(503, "Gemini is currently unavailable. Please try again later.");
}

async function createSearchPlan(
  requestId: string,
  videoInput: InlineVideoInput,
  prompt: string,
  geminiSettings: GeminiRequestSettings,
): Promise<SearchPlan> {
  logEvent(requestId, "search_plan_started", {
    queryCount: exaSearchQueryCount,
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
          text: buildSearchPlanningPrompt(prompt),
        },
      ],
      config: {
        abortSignal: AbortSignal.timeout(geminiTimeoutMs),
        maxOutputTokens: searchPlanMaxOutputTokens,
        responseMimeType: "application/json",
        systemInstruction: [
          "You are a fact-checking research planner.",
          "Watch the supplied video and identify the claims that need outside verification.",
          "Return only valid JSON matching the requested schema.",
        ].join(" "),
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: geminiSettings.thinkingLevel,
        },
      },
    },
  );

  const plan = parseSearchPlan(response.text ?? "");

  if (!plan.searches.length) {
    throw new HttpError(502, "Gemini did not produce any Exa search queries.");
  }

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
  });

  return plan;
}

function buildSearchPlanningPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Create search queries for Exa that will verify the most important factual claims in the video.",
    `Return exactly ${exaSearchQueryCount} different individual search quer${exaSearchQueryCount === 1 ? "y" : "ies"}.`,
    "Choose queries that cover different angles of the claims so the final fact-check has a wide scope.",
    "Avoid near-duplicate queries when possible; if the topic is very specific and overlap is unavoidable, prioritize useful coverage over artificial variety.",
    "If the video contains fewer obvious factual claims than the requested query count, create broader corroborating searches for context, source material, dates, locations, people, organizations, and quoted claims.",
    "Prefer precise queries with names, places, dates, quoted phrases, organizations, laws, events, statistics, and other distinctive terms visible or spoken in the video.",
    "Do not search for generic terms like fact check, viral video, or TikTok unless they are part of the claim.",
    "",
    "Return exactly this JSON shape:",
    '{"searches":[{"query":"specific search query","rationale":"brief reason this search is needed"}]}',
  ].join("\n");
}

function parseSearchPlan(rawText: string): SearchPlan {
  const parsed = parseJsonObject(rawText);
  const rawSearches = Array.isArray(parsed?.searches) ? parsed.searches : [];
  const searches: SearchQuery[] = [];
  const seen = new Set<string>();

  for (const value of rawSearches) {
    if (!isRecord(value) || typeof value.query !== "string") {
      continue;
    }

    const query = value.query.trim();
    const normalized = query.toLowerCase();

    if (!query || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    searches.push({
      query,
      rationale: typeof value.rationale === "string" && value.rationale.trim() ? value.rationale.trim() : null,
    });

    if (searches.length >= exaSearchQueryCount) {
      break;
    }
  }

  return { searches };
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return null;
  }

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed: unknown = JSON.parse(withoutFence);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseRequestMode(rawMode: string | undefined): { mode: RequestMode } | { error: string } {
  const mode = rawMode?.trim().toLowerCase() || "direct";

  if (mode !== "direct" && mode !== "queue") {
    return { error: "The mode field must be either direct or queue." };
  }

  return { mode };
}

function parseMultipartModelEntry(modelEntry: FormDataEntryValue | null): string | string[] | undefined {
  if (typeof modelEntry !== "string") {
    return undefined;
  }

  const trimmed = modelEntry.trim();

  if (!trimmed.startsWith("[")) {
    return modelEntry;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : modelEntry;
  } catch {
    return modelEntry;
  }
}

function parseGeminiOverrides(
  rawModel: string | string[] | undefined,
  rawReasoningEffort: string | undefined,
): GeminiRequestSettings | { error: string } {
  try {
    const model = normalizeRequestedModel(rawModel);
    const reasoningEffort = rawReasoningEffort?.trim().toLowerCase()
      ? rawReasoningEffort.trim().toLowerCase()
      : defaultGeminiSettings.reasoningEffort;

    return resolveGeminiSettings(model, reasoningEffort);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid Gemini model or reasoningEffort.",
    };
  }
}

function resolveGeminiSettings(
  rawModel: SupportedGeminiModel | [SupportedGeminiModel, SupportedGeminiModel] | string | string[],
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
    model: models.searchPlan === models.finalAnswer ? models.searchPlan : [models.searchPlan, models.finalAnswer],
    models,
    reasoningEffort: rawReasoningEffort,
    thinkingLevel: thinkingLevelByReasoningEffort[rawReasoningEffort],
  };
}

function normalizeRequestedModel(
  rawModel: string | string[] | undefined,
): SupportedGeminiModel | [SupportedGeminiModel, SupportedGeminiModel] {
  if (typeof rawModel === "undefined") {
    return defaultGeminiSettings.model;
  }

  if (typeof rawModel === "string") {
    const model = rawModel.trim() || defaultGeminiSettings.model;

    if (!isSupportedGeminiModel(model)) {
      throw new Error(`The model field must be one of: ${supportedGeminiModels.join(", ")}.`);
    }

    return model;
  }

  if (rawModel.length !== 2) {
    throw new Error("The model array must contain exactly two model IDs: search planning, then final answer.");
  }

  const models = rawModel.map((model) => model.trim());

  for (const model of models) {
    if (!isSupportedGeminiModel(model)) {
      throw new Error(`Each model array item must be one of: ${supportedGeminiModels.join(", ")}.`);
    }
  }

  return [models[0] as SupportedGeminiModel, models[1] as SupportedGeminiModel];
}

function resolveGeminiStepModels(
  rawModel: SupportedGeminiModel | [SupportedGeminiModel, SupportedGeminiModel] | string | string[],
): GeminiRequestSettings["models"] {
  const normalized = normalizeRequestedModel(Array.isArray(rawModel) ? rawModel : String(rawModel));

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

function isSupportedGeminiModel(value: string): value is SupportedGeminiModel {
  return supportedGeminiModels.includes(value as SupportedGeminiModel);
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return supportedReasoningEfforts.includes(value as ReasoningEffort);
}

async function runExaSearches(requestId: string, searches: SearchQuery[]): Promise<SearchResultContext[]> {
  logEvent(requestId, "exa_search_started", {
    searchType: exaSearchType,
    queryCount: searches.length,
    resultsPerQuery: exaResultsPerQuery,
    textMaxCharacters: exaTextMaxCharacters,
  });

  const responses = await Promise.all(searches.map((search) => runExaSearch(search.query)));
  const seenUrls = new Set<string>();
  const results: SearchResultContext[] = [];

  for (let index = 0; index < responses.length; index += 1) {
    const query = searches[index]?.query ?? "";

    for (const result of responses[index].results ?? []) {
      const url = typeof result.url === "string" ? result.url.trim() : "";
      const text = typeof result.text === "string" ? result.text.trim() : "";

      if (!url || !text || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      results.push({
        author: typeof result.author === "string" && result.author.trim() ? result.author.trim() : null,
        publishedDate: typeof result.publishedDate === "string" && result.publishedDate.trim()
          ? result.publishedDate.trim()
          : null,
        query,
        text,
        title: typeof result.title === "string" && result.title.trim() ? result.title.trim() : null,
        url,
      });
    }
  }

  logEvent(requestId, "exa_search_completed", {
    queryCount: searches.length,
    resultCount: results.length,
    results: results.map((result) => ({
      query: result.query,
      title: result.title,
      url: result.url,
      textLength: result.text.length,
    })),
  });

  return results;
}

async function runExaSearch(query: string): Promise<ExaSearchResponse> {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": exaApiKey,
    },
    body: JSON.stringify({
      query,
      type: exaSearchType,
      numResults: exaResultsPerQuery,
      contents: {
        text: {
          maxCharacters: exaTextMaxCharacters,
        },
      },
    }),
    signal: AbortSignal.timeout(exaTimeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      `Exa search failed with status ${response.status}.${errorText ? ` ${truncate(errorText, 500)}` : ""}`,
    );
  }

  const body: unknown = await response.json();
  return isRecord(body) ? body as ExaSearchResponse : {};
}

function buildSearchContext(results: SearchResultContext[], searches: SearchQuery[]): string {
  if (!results.length) {
    return [
      "No Exa search results were returned. Say that outside evidence was unavailable instead of guessing.",
      "",
      "Exa searches performed:",
      ...searches.map((search) => search.query),
    ].join("\n");
  }

  return [
    "Exa searches performed:",
    ...searches.map((search) => search.query),
    "",
    "Exa search results with full page text:",
    ...results.map((result, index) => [
      "",
      `Source ${index + 1}`,
      `Query: ${result.query}`,
      `Title: ${result.title ?? "Untitled"}`,
      `URL: ${result.url}`,
      `Published date: ${result.publishedDate ?? "Unknown"}`,
      `Author: ${result.author ?? "Unknown"}`,
      "Full text:",
      result.text,
    ].join("\n")),
  ].join("\n");
}

function buildFactCheckPrompt(url: string | null, additionalContext: string | null, searchContext?: string): string {
  const sections = [
    "Watch the full video carefully.",
    "Identify the material factual claims made in speech, captions, on-screen text, and visuals.",
    "Fact-check those claims against the Exa search evidence provided below.",
    "Use the search evidence to verify dates, places, names, health claims, politics, science, history, crime, war, statistics, alleged quotes, and other factual details.",
    "When a conclusion is supported by Exa results, cite in the main text with bracket numbers only: one source is [1]; several sources are written as adjacent brackets, e.g. [1][2][4][9], never [1, 2, 4, 9]. Each number refers to the same-numbered line in the Sources list at the end. Do not paste long URLs in the main paragraphs.",
    "If the search evidence does not cover a claim, say it is unverifiable from the available evidence.",
    "For origin stories, distinguish claims that are historically supported from claims that are merely widely repeated but uncertain.",
    "",
    "Output format requirements (very important): the entire response must be plain text with no markdown. No # headings, no asterisks for bold or italics, no backticks, no link syntax like square brackets for URLs, no blockquotes, no code fences, no tables.",
    "Start with a line exactly in this format: Confidence: X/10 where X is a whole number from 1 to 10.",
    "Calibrate the confidence score realistically. Do not be overly generous or overly harsh. Use moderate scores for mixed or incomplete evidence, and reserve extreme scores for unusually strong or unusually weak evidence.",
    "After that, add a blank line and then a line exactly: Explanation:",
    "Under Explanation:, write one short overall verdict sentence first.",
    "Then write one short summary paragraph.",
    "Then cover each significant claim in plain text as continuous paragraphs, one after another, using [1] or [1][2] style references (adjacent brackets only) where evidence applies.",
    "For each claim, say whether it is true, false, misleading, missing context, or unverifiable, and explain why.",
    "Call out omitted context, outdated footage, manipulated framing, and mismatches between the visuals and the narration when present.",
    "After the explanation paragraphs, on its own, add a blank line, then a line with exactly: Sources:",
    "Then one line per cited source in order, each line exactly: [n] - https://full.url/path (for example: [1] - https://example.com/page )",
    "After the source lines, add a blank line, then a line with exactly: Searches:",
    "Then list every Exa search query from the Exa searches performed section, one per line in order, exactly in this format: (1) - query text, (2) - query text, and so on, with no bullets or extra text.",
  ];

  if (url) {
    sections.unshift("", `Source video URL: ${url}`);
  }

  if (additionalContext) {
    sections.push("", `Additional context from the API caller: ${additionalContext}`);
  }

  if (searchContext) {
    sections.push("", searchContext);
  }

  return sections.join("\n");
}

function normalizeMimeType(value: string | null): string {
  const mimeType = value?.split(";")[0]?.trim().toLowerCase();

  if (!mimeType || mimeType === "application/octet-stream") {
    return "video/mp4";
  }

  return mimeType;
}

function getFilenameFromHeaders(headers: Headers): string | null {
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

function buildWarnings(searches: SearchQuery[], results: SearchResultContext[]): string[] {
  const warnings: string[] = [];

  if (!searches.length) {
    warnings.push("Gemini did not produce any Exa search queries for this response.");
  } else if (searches.length < exaSearchQueryCount) {
    warnings.push(`Gemini produced only ${searches.length} Exa search quer${searches.length === 1 ? "y" : "ies"}, below the configured target of ${exaSearchQueryCount}.`);
  }

  if (!results.length) {
    warnings.push("Exa did not return any full-text search results for the generated queries.");
  }

  return warnings;
}

function extractThoughtText(parts: Part[] | undefined): string | null {
  const thoughts = (parts ?? [])
    .filter((part) => part.thought && typeof part.text === "string" && part.text.trim())
    .map((part) => part.text!.trim());

  if (!thoughts.length) {
    return null;
  }

  return thoughts.join("\n\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGeminiHighDemandError(error: unknown): boolean {
  const status = getErrorStatus(error);
  const message = error instanceof Error ? error.message : JSON.stringify(error);

  return status === 503
    && (
      message.toLowerCase().includes("high demand")
      || message.includes("\"UNAVAILABLE\"")
      || message.toLowerCase().includes("currently unavailable")
    );
}

function getErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  const status = error.status;

  if (typeof status === "number") {
    return status;
  }

  if (typeof status === "string") {
    const parsed = Number.parseInt(status, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function logEvent(requestId: string | null, event: string, payload: Record<string, unknown>): void {
  const prefix = requestId ? `[fact-check:${requestId}]` : "[fact-check]";
  console.log(`${prefix} ${event} ${JSON.stringify(payload)}`);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function handleFactCheckError(error: unknown): Response {
  const normalized = normalizeFactCheckError(error);
  return Response.json({ error: normalized.error }, { status: normalized.status });
}

function normalizeFactCheckError(error: unknown): { error: string; status: ErrorStatus } {
  if (error instanceof HttpError) {
    return {
      error: error.message,
      status: isSupportedErrorStatus(error.status) ? error.status : 500,
    };
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { error: "The upstream request timed out.", status: 504 };
  }

  const status = getErrorStatus(error);

  if (status && isSupportedErrorStatus(status)) {
    return {
      error: error instanceof Error ? error.message : "The upstream request failed.",
      status,
    };
  }

  if (error instanceof Error) {
    return { error: error.message, status: 500 };
  }

  return { error: "Unknown error.", status: 500 };
}

function isSupportedErrorStatus(status: number): status is ErrorStatus {
  return [400, 413, 429, 500, 502, 503, 504].includes(status);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
