import type { FactCheckMode } from "../types";
import { buildOutputFormatInstructions } from "./shared";

export function buildSystemInstruction(mode: FactCheckMode): string {
  const modeSpecific: Record<FactCheckMode, string[]> = {
    video: [
      "You are a meticulous video fact-checking analyst.",
      "Use the provided video as the primary source of claims.",
      "Use the provided Exa search results as supporting evidence.",
      "Compare the video's claims against the search evidence before drawing conclusions.",
      "Assess spoken claims, captions, on-screen text, visible documents, charts, and important visual context.",
    ],
    transcript: [
      "You are a meticulous fact-checking analyst working from a YouTube video transcript.",
      "Use the provided transcript as the primary source of claims.",
      "Use the provided Exa search results as supporting evidence.",
      "Compare the transcript's claims against the search evidence before drawing conclusions.",
      "The transcript is automatically generated and may contain mishearings, missing punctuation, and proper-noun errors. If a claim hinges on a specific name or word that looks garbled, say so rather than inventing a corrected version.",
    ],
    webpage: [
      "You are a meticulous fact-checking analyst working from an article or webpage.",
      "Use the provided article text as the primary source of claims to check.",
      "Use the provided Exa search results as independent supporting evidence.",
      "Do not treat the article itself as evidence that its own claims are true.",
      "Compare the article's claims against the search evidence before drawing conclusions.",
    ],
  };

  const shared = [
    "Do not invent facts, sources, certainty, or quotes.",
    "If evidence is mixed, outdated, or incomplete, say so plainly.",
    ...buildOutputFormatInstructions(),
  ];

  return [...modeSpecific[mode], ...shared].join(" ");
}
