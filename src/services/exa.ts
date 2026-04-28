import {
  exaApiKey,
  exaRetryCount,
  exaRetryDelayMs,
  exaTextMaxCharacters,
  exaTimeoutMs,
} from "../config";
import type {
  ExaContentsResponse,
  ExaSearchResponse,
  ExaSearchType,
  SearchQuery,
  SearchResultContext,
} from "../types";
import { HttpError, throwIfNotOk } from "../utils/errors";
import {
  combineAbortSignals,
  fetchWithRetry,
  limitText,
  normalizeUrlKey,
} from "../utils/helpers";
import { isRecord } from "../utils/validation";
import { logEvent } from "../utils/logging";

export async function getExaWebpageContent(
  requestId: string,
  url: string,
  clientSignal?: AbortSignal,
): Promise<SearchResultContext & { truncated: boolean }> {
  logEvent(requestId, "exa_contents_started", {
    url,
    textMaxCharacters: exaTextMaxCharacters,
  });

  const signal = combineAbortSignals(clientSignal, AbortSignal.timeout(exaTimeoutMs));

  const response = await fetchWithRetry(
    () =>
      fetch("https://api.exa.ai/contents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": exaApiKey,
        },
        body: JSON.stringify({
          urls: [url],
          text: true,
        }),
        signal,
      }),
    {
      maxRetries: exaRetryCount,
      retryDelayMs: exaRetryDelayMs,
      retryableStatuses: [429, 502, 503, 504],
      serviceName: "Exa contents",
      requestId,
    },
  );

  await throwIfNotOk(response, "Exa contents", response.status === 429 ? 429 : 502);

  const body: unknown = await response.json();
  const contents = isRecord(body) ? (body as ExaContentsResponse) : {};
  const result = contents.results?.[0];
  const text = typeof result?.text === "string" ? result.text.trim() : "";

  if (!result || !text) {
    const status = contents.statuses?.[0];
    const statusDetail = status?.error
      ? ` ${status.error.tag ?? "unknown"}${status.error.httpStatusCode ? ` (${status.error.httpStatusCode})` : ""}`
      : "";

    throw new HttpError(
      502,
      `Exa could not retrieve readable webpage text.${statusDetail}`,
    );
  }

  const limitedText = limitText(text, exaTextMaxCharacters);
  const webpage = {
    author:
      typeof result.author === "string" && result.author.trim()
        ? result.author.trim()
        : null,
    publishedDate:
      typeof result.publishedDate === "string" && result.publishedDate.trim()
        ? result.publishedDate.trim()
        : null,
    query: "source webpage",
    text: limitedText.text,
    title:
      typeof result.title === "string" && result.title.trim()
        ? result.title.trim()
        : null,
    url:
      typeof result.url === "string" && result.url.trim()
        ? result.url.trim()
        : url,
    truncated: limitedText.truncated,
  };

  logEvent(requestId, "exa_contents_completed", {
    requestId: contents.requestId ?? null,
    requestedUrl: url,
    resolvedUrl: webpage.url,
    title: webpage.title,
    publishedDate: webpage.publishedDate,
    author: webpage.author,
    textCharacters: webpage.text.length,
    originalTextCharacters: text.length,
    truncated: webpage.truncated,
    statuses: contents.statuses ?? null,
  });

  return webpage;
}

export async function runExaSearches(
  requestId: string,
  searches: SearchQuery[],
  resultsPerQuery: number,
  searchType: ExaSearchType,
  excludedUrls: string[] = [],
  clientSignal?: AbortSignal,
): Promise<SearchResultContext[]> {
  const excludedUrlKeys = new Set(
    excludedUrls
      .map((url) => normalizeUrlKey(url))
      .filter((urlKey): urlKey is string => Boolean(urlKey)),
  );

  logEvent(requestId, "exa_search_started", {
    searchType,
    queryCount: searches.length,
    resultsPerQuery,
    textMaxCharacters: exaTextMaxCharacters,
    excludedUrls,
  });

  const responses = await Promise.all(
    searches.map((search) =>
      runExaSearch(requestId, search.query, resultsPerQuery, searchType, clientSignal),
    ),
  );
  const seenUrls = new Set<string>();
  const results: SearchResultContext[] = [];

  for (let index = 0; index < responses.length; index += 1) {
    const query = searches[index]?.query ?? "";

    for (const result of responses[index].results ?? []) {
      const url = typeof result.url === "string" ? result.url.trim() : "";
      const text = typeof result.text === "string" ? result.text.trim() : "";
      const urlKey = normalizeUrlKey(url);

      if (
        !url ||
        !text ||
        !urlKey ||
        seenUrls.has(urlKey) ||
        excludedUrlKeys.has(urlKey)
      ) {
        continue;
      }

      seenUrls.add(urlKey);
      results.push({
        author:
          typeof result.author === "string" && result.author.trim()
            ? result.author.trim()
            : null,
        publishedDate:
          typeof result.publishedDate === "string" &&
          result.publishedDate.trim()
            ? result.publishedDate.trim()
            : null,
        query,
        text,
        title:
          typeof result.title === "string" && result.title.trim()
            ? result.title.trim()
            : null,
        url,
      });
    }
  }

  logEvent(requestId, "exa_search_completed", {
    searchType,
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

export async function runExaSearch(
  requestId: string,
  query: string,
  resultsPerQuery: number,
  searchType: ExaSearchType,
  clientSignal?: AbortSignal,
): Promise<ExaSearchResponse> {
  const signal = combineAbortSignals(clientSignal, AbortSignal.timeout(exaTimeoutMs));

  const response = await fetchWithRetry(
    () =>
      fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": exaApiKey,
        },
        body: JSON.stringify({
          query,
          type: searchType,
          numResults: resultsPerQuery,
          contents: {
            text: {
              maxCharacters: exaTextMaxCharacters,
            },
          },
        }),
        signal,
      }),
    {
      maxRetries: exaRetryCount,
      retryDelayMs: exaRetryDelayMs,
      retryableStatuses: [429, 502, 503, 504],
      serviceName: "Exa search",
      requestId,
    },
  );

  await throwIfNotOk(response, "Exa search", response.status === 429 ? 429 : 502);

  const body: unknown = await response.json();
  return isRecord(body) ? (body as ExaSearchResponse) : {};
}

export function buildSearchContext(
  results: SearchResultContext[],
  searches: SearchQuery[],
): string {
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
    ...results.map((result, index) =>
      [
        "",
        `Source ${index + 1}`,
        `Query: ${result.query}`,
        `Title: ${result.title ?? "Untitled"}`,
        `URL: ${result.url}`,
        `Published date: ${result.publishedDate ?? "Unknown"}`,
        `Author: ${result.author ?? "Unknown"}`,
        "Full text:",
        result.text,
      ].join("\n"),
    ),
  ].join("\n");
}

export function buildWarnings(
  searches: SearchQuery[],
  results: SearchResultContext[],
  targetQueryCount: number,
  upperBoundOnly: boolean,
): string[] {
  const warnings: string[] = [];

  if (!searches.length) {
    warnings.push(
      "Gemini did not produce any Exa search queries for this response.",
    );
  } else if (!upperBoundOnly && searches.length < targetQueryCount) {
    warnings.push(
      `Gemini produced only ${searches.length} Exa search quer${searches.length === 1 ? "y" : "ies"}, below the configured target of ${targetQueryCount}.`,
    );
  }

  if (!results.length) {
    warnings.push(
      "Exa did not return any full-text search results for the generated queries.",
    );
  }

  return warnings;
}
