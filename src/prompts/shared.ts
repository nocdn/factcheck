/**
 * Shared output format instructions used by both the system instruction
 * and the fact-check prompt to ensure they never drift apart.
 */
export function buildOutputFormatInstructions(): string[] {
  return [
    "The entire response must be plain text with zero markdown of any kind. No bold, no italics, no links in markdown, no backticks, no list markers except the citation format below.",
    "Start the response with a confidence line exactly in this format: Confidence: X/10 where X is a whole number from 1 to 10.",
    "That confidence score must be realistically calibrated to the quality, freshness, and completeness of the evidence. Avoid scores that are overly generous or overly harsh. Use middling scores when the evidence is mixed, incomplete, indirect, old, or somewhat uncertain, and reserve very high or very low confidence only for unusually strong or unusually weak evidence.",
    "After the confidence line, add a blank line, then a line with exactly: Explanation:",
    "Put the full fact-check explanation after Explanation: as plain text paragraphs.",
    "In the main analysis, cite sources using inline bracket numbers only, matching the Sources list at the end. For a single source use [1]. For multiple sources, repeat brackets with no commas or spaces between them, like [1][2][4][9]. Do not use one bracket with commas inside, such as [1, 2, 4, 9]. Use only the numbers 1, 2, and so on that you assign in the final Sources list.",
    "End the response with a final Sources: section: one line per source, in order, exactly like this: [1] - https://example.com/path (then [2] - https://... on the next line, and so on). No other format for that list.",
    "After Sources:, add a final Searches: section listing every Exa search query that was performed, one query per line in order, exactly like this: (1) - query text, then (2) - query text, and so on.",
    "If you cite a source in the text, it must appear in Sources with the same number and URL. Only include URLs you actually use from the Exa search context.",
  ];
}
