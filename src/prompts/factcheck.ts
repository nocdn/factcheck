import type { FactCheckMode, SearchResultContext } from "../types";
import { buildOutputFormatInstructions } from "./shared";

export function buildFactCheckPrompt(
  mode: FactCheckMode,
  options: {
    url?: string | null;
    additionalContext?: string | null;
    transcript?: string;
    webpage?: SearchResultContext & { truncated: boolean };
    searchContext?: string;
  },
): string {
  const sections: string[] = [];

  if (options.url && mode !== "webpage") {
    sections.push(`Source video URL: ${options.url}`, "");
  }

  if (mode === "video") {
    sections.push(
      "Watch the full video carefully.",
      "Identify the material factual claims made in speech, captions, on-screen text, and visuals.",
      "Fact-check those claims against the Exa search evidence provided below.",
    );
  } else if (mode === "transcript") {
    sections.push(
      "Fact-check the following YouTube video using its automatically generated transcript and the provided Exa search evidence.",
      "Identify the material factual claims made in the transcript and check them against the Exa results.",
      "Note that automatic transcripts may contain mishearings or proper-noun errors; if a claim hinges on a specific name or word that looks garbled in the transcript, say so rather than inventing a corrected version.",
    );
  } else {
    sections.push(
      "Fact-check the following article or webpage using the provided Exa search evidence.",
      "Identify the material factual claims made in the article and check them against independent search results.",
      "Do not treat the article itself as evidence that its own claims are true.",
    );
  }

  sections.push(
    "Use the search evidence to verify dates, places, names, health claims, politics, science, history, crime, war, statistics, alleged quotes, and other factual details.",
    "When a conclusion is supported by Exa results, cite in the main text with bracket numbers only: one source is [1]; several sources are written as adjacent brackets, e.g. [1][2][4][9], never [1, 2, 4, 9]. Each number refers to the same-numbered line in the Sources list at the end. Do not paste long URLs in the main paragraphs.",
    "If the search evidence does not cover a claim, say it is unverifiable from the available evidence.",
    "For origin stories, distinguish claims that are historically supported from claims that are merely widely repeated but uncertain.",
    "",
    "Output format requirements (very important):",
    ...buildOutputFormatInstructions(),
    "Under Explanation:, write one short overall verdict sentence first.",
    "Then write one short summary paragraph.",
    "Then cover each significant claim in plain text as continuous paragraphs, one after another, using [1] or [1][2] style references (adjacent brackets only) where evidence applies.",
    "For each claim, say whether it is true, false, misleading, missing context, or unverifiable, and explain why.",
    "Call out omitted context, outdated information, manipulated or misleading framing, mismatches between sources and claims, and other misinformation patterns when present.",
  );

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
    sections.push(
      "",
      "Article metadata:",
      `Title: ${options.webpage.title ?? "Untitled"}`,
      `URL: ${options.webpage.url}`,
      `Published date: ${options.webpage.publishedDate ?? "Unknown"}`,
      `Author: ${options.webpage.author ?? "Unknown"}`,
      `Text truncated: ${options.webpage.truncated ? "yes" : "no"}`,
      "",
      "Article text:",
      options.webpage.text,
    );
  }

  if (options.searchContext) {
    sections.push("", options.searchContext);
  }

  return sections.join("\n");
}
