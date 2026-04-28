import type { FactCheckMode, SearchPlan, SearchQuery } from "../types";

export function buildSearchPlanningPrompt(
  mode: FactCheckMode,
  maxQueries: number,
  options: {
    url?: string | null;
    additionalContext?: string | null;
    embeddedPrompt?: string;
    transcript?: string;
    webpage?: {
      author: string | null;
      publishedDate: string | null;
      query: string;
      text: string;
      title: string | null;
      url: string;
      truncated: boolean;
    };
  },
): string {
  const sections: string[] = [];

  if (options.embeddedPrompt) {
    sections.push(options.embeddedPrompt, "");
  }

  if (mode === "transcript") {
    sections.push(
      "You are creating Exa web search queries to fact-check a YouTube video.",
      "You only have the transcript of the video; you do not see or hear the video itself.",
    );
  } else if (mode === "webpage") {
    sections.push(
      "You are creating Exa web search queries to fact-check an article or webpage.",
    );
  } else {
    sections.push(
      "Create search queries for Exa that will verify the most important factual claims in the video.",
    );
  }

  const sourceName =
    mode === "transcript"
      ? "transcript"
      : mode === "webpage"
        ? "article"
        : "video";
  const genericTerms =
    mode === "transcript"
      ? "fact check, viral video, or YouTube short"
      : mode === "webpage"
        ? "fact check or viral article"
        : "fact check, viral video, or TikTok";

  sections.push(
    `Read the ${sourceName} carefully and identify the material factual claims that need outside verification, including names, dates, places, statistics, scientific or medical claims, political or historical claims, alleged quotes, events, organizations, and other distinctive factual details.`,
  );

  if (mode === "transcript") {
    sections.push(
      `YouTube videos can be long and contain many independent claims. Generate as many search queries as you need to cover the important claims, but never more than ${maxQueries} queries in total.`,
    );
  } else {
    sections.push(
      `Return up to ${maxQueries} different individual search quer${maxQueries === 1 ? "y" : "ies"}.`,
    );
  }

  sections.push(
    "Choose queries that cover different important claims or evidence angles so the final fact-check has useful breadth.",
    "If the source contains multiple distinct claims, distribute the searches across as many important claims as possible instead of over-focusing on only one claim or angle.",
    "Do not pad with filler searches when the source has only a few material claims; only add queries that can verify a distinct claim or useful context.",
    "Avoid near-duplicate queries when possible; if the topic is very specific and overlap is unavoidable, prioritize useful coverage over artificial variety.",
    "Prefer precise queries with names, places, dates, quoted phrases, organizations, laws, events, statistics, and other distinctive terms from the source.",
    `Do not search for generic terms like ${genericTerms} unless they are part of the claim.`,
  );

  if (mode === "transcript") {
    sections.push(
      "Treat the transcript as automatically generated, so it may contain mishearings or proper-noun errors; if a name or term in the transcript looks garbled, search for the most plausible spelling rather than copying the obvious error.",
    );
  }

  sections.push(
    "",
    "Return exactly this JSON shape:",
    '{"searches":[{"query":"specific search query","rationale":"brief reason this search is needed"}]}',
  );

  if (mode === "webpage" && options.webpage) {
    sections.push(
      "",
      "Article metadata:",
      `Title: ${options.webpage.title ?? "Untitled"}`,
      `URL: ${options.webpage.url}`,
      `Published date: ${options.webpage.publishedDate ?? "Unknown"}`,
      `Author: ${options.webpage.author ?? "Unknown"}`,
      `Text truncated: ${options.webpage.truncated ? "yes" : "no"}`,
    );
  }

  if (options.url && mode !== "webpage") {
    sections.push("", `Source video URL: ${options.url}`);
  }

  if (options.additionalContext) {
    sections.push(
      "",
      `Additional context from the API caller: ${options.additionalContext}`,
    );
  }

  if (mode === "transcript" && options.transcript) {
    sections.push("", "Transcript of the YouTube video:", options.transcript);
  }

  if (mode === "webpage" && options.webpage) {
    sections.push("", "Article text:", options.webpage.text);
  }

  return sections.join("\n");
}

export function buildSearchPlannerSystemInstruction(
  mode: FactCheckMode,
): string {
  const action =
    mode === "video"
      ? "Watch the supplied video"
      : mode === "transcript"
        ? "Read the supplied YouTube video transcript"
        : "Read the supplied article or webpage";

  return [
    "You are a fact-checking research planner.",
    `${action} and identify the claims that need outside verification.`,
    "Return only valid JSON matching the requested schema.",
  ].join(" ");
}

export function parseSearchPlan(rawText: string, maxQueries: number): SearchPlan {
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
      rationale:
        typeof value.rationale === "string" && value.rationale.trim()
          ? value.rationale.trim()
          : null,
    });

    if (searches.length >= maxQueries) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
