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
const geminiModel = process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview";
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
const factCheckMaxOutputTokens = parseIntegerEnv("FACT_CHECK_MAX_OUTPUT_TOKENS", 8_192);
const searchPlanMaxOutputTokens = parseIntegerEnv("FACT_CHECK_SEARCH_PLAN_MAX_OUTPUT_TOKENS", 2_048);

const supportedQualities = new Set([
  "best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
]);

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

const factCheckSystemInstruction = [
  "You are a meticulous video fact-checking analyst.",
  "Use the provided video as the primary source of claims.",
  "Use the provided Exa search results as supporting evidence.",
  "Compare the video's claims against the search evidence before drawing conclusions.",
  "Assess spoken claims, captions, on-screen text, visible documents, charts, and important visual context.",
  "Do not invent facts, sources, certainty, or quotes.",
  "If evidence is mixed, outdated, or incomplete, say so plainly.",
  "The final fact-check must be plain text only with zero markdown of any kind; that is very important. No headers, no bold, no italics, no links in markdown, no backticks, no list markers except the citation format below.",
  "In the main analysis, cite sources using inline bracket numbers only, matching the Sources list at the end. For a single source use [1]. For multiple sources, repeat brackets with no commas or spaces between them, like [1][2][4][9]. Do not use one bracket with commas inside, such as [1, 2, 4, 9]. Use only the numbers 1, 2, and so on that you assign in the final Sources list.",
  "End the response with a final Sources: section: one line per source, in order, exactly like this: [1] - https://example.com/path (then [2] - https://... on the next line, and so on). No other format for that list.",
  "After Sources:, add a final Searches: section listing every Exa search query that was performed, one raw query per line with no numbering or prefixes.",
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
    model: geminiModel,
  });
});

app.get("/api", (c) => {
  return c.json({
    name: "factcheck",
    status: "ok",
    port,
    routes: ["/api/health", "/api/check"],
    model: geminiModel,
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

  const requestId = createRequestId();
  logEvent(requestId, "fact_check_request_received", {
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
    geminiModel,
  });

  try {
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
    const searchPlan = await createSearchPlan(requestId, videoInput, prompt);
    const searchResults = await runExaSearches(requestId, searchPlan.searches);
    const searchContext = buildSearchContext(searchResults, searchPlan.searches);
    const finalPrompt = buildFactCheckPrompt(parsedBody.url, parsedBody.additionalContext, searchContext);

    logEvent(requestId, "gemini_request_prepared", {
      inputMode: parsedBody.inputMode,
      sourceUrl: parsedBody.url,
      mimeType: videoInput.mimeType,
      sizeBytes: videoInput.sizeBytes,
      filename: videoInput.filename,
      systemInstructionPreview: truncate(factCheckSystemInstruction, 300),
      promptPreview: truncate(finalPrompt, 500),
      responseMimeType: "text/plain",
      thinkingLevel: ThinkingLevel.HIGH,
      exaSearchEnabled: true,
      exaSearchQueryCount: searchPlan.searches.length,
      exaSearchResultCount: searchResults.length,
      includeThoughts: true,
    });

    const response = await ai.models.generateContent({
      model: geminiModel,
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
          thinkingLevel: ThinkingLevel.HIGH,
        },
      },
    });

    const analysis = response.text?.trim() || "";

    if (!analysis) {
      return c.json({ error: "Gemini returned an empty response." }, 502);
    }

    const candidate = response.candidates?.[0];
    const reasoning = extractThoughtText(candidate?.content?.parts);
    const warnings = buildWarnings(searchPlan.searches, searchResults);

    logEvent(requestId, "gemini_response_received", {
      responseId: response.responseId ?? null,
      modelVersion: response.modelVersion ?? null,
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

    return c.json({
      id: requestId,
      inputMode: parsedBody.inputMode,
      url: parsedBody.url,
      model: geminiModel,
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
    });
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

function parseIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseBoundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = parseIntegerEnv(name, fallback);
  return Math.min(Math.max(value, minimum), maximum);
}

function createRequestId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function parseFactCheckRequest(
  request: Request,
): Promise<
  | {
      additionalContext: string | null;
      inputMode: "url";
      iosCompatible: boolean;
      proxy: boolean;
      quality: string;
      url: string;
    }
  | {
      additionalContext: string | null;
      bytes: Uint8Array;
      filename: string;
      inputMode: "file";
      mimeType: string;
      sizeBytes: number;
      url: string | null;
    }
  | { error: string; status: 400 | 413 }
> {
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

  return {
    additionalContext: typeof body.additionalContext === "string" && body.additionalContext.trim()
      ? body.additionalContext.trim()
      : null,
    inputMode: "url",
    iosCompatible: typeof body.iosCompatible === "boolean" ? body.iosCompatible : true,
    proxy: typeof body.proxy === "boolean" ? body.proxy : false,
    quality,
    url: parsedUrl.toString(),
  };
}

async function parseMultipartFactCheckRequest(
  request: Request,
): Promise<
  | {
      additionalContext: string | null;
      bytes: Uint8Array;
      filename: string;
      inputMode: "file";
      mimeType: string;
      sizeBytes: number;
      url: string | null;
    }
  | { error: string; status: 400 | 413 }
> {
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
    sizeBytes: bytes.byteLength,
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

async function createSearchPlan(
  requestId: string,
  videoInput: InlineVideoInput,
  prompt: string,
): Promise<SearchPlan> {
  logEvent(requestId, "search_plan_started", {
    queryCount: exaSearchQueryCount,
    mimeType: videoInput.mimeType,
    sizeBytes: videoInput.sizeBytes,
  });

  const response = await ai!.models.generateContent({
    model: geminiModel,
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
        thinkingLevel: ThinkingLevel.LOW,
      },
    },
  });

  const plan = parseSearchPlan(response.text ?? "");

  if (!plan.searches.length) {
    throw new HttpError(502, "Gemini did not produce any Exa search queries.");
  }

  logEvent(requestId, "search_plan_completed", {
    responseId: response.responseId ?? null,
    modelVersion: response.modelVersion ?? null,
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
    "Write one short overall verdict sentence first.",
    "Then write one short summary paragraph.",
    "Then cover each significant claim in plain text as continuous paragraphs, one after another, using [1] or [1][2] style references (adjacent brackets only) where evidence applies.",
    "For each claim, say whether it is true, false, misleading, missing context, or unverifiable, and explain why.",
    "Call out omitted context, outdated footage, manipulated framing, and mismatches between the visuals and the narration when present.",
    "After the analysis, on its own, add a blank line, then a line with exactly: Sources:",
    "Then one line per cited source in order, each line exactly: [n] - https://full.url/path (for example: [1] - https://example.com/page )",
    "After the source lines, add a blank line, then a line with exactly: Searches:",
    "Then list every Exa search query from the Exa searches performed section, one raw query per line, with no numbers, bullets, prefixes, or extra text.",
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

function logEvent(requestId: string | null, event: string, payload: Record<string, unknown>): void {
  const prefix = requestId ? `[fact-check:${requestId}]` : "[fact-check]";
  console.log(`${prefix} ${event} ${JSON.stringify(payload)}`);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function handleFactCheckError(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return Response.json({ error: "The upstream request timed out." }, { status: 504 });
  }

  if (error instanceof Error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ error: "Unknown error." }, { status: 500 });
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
