import { z } from "zod";
import {
  defaultGeminiSettings,
  exaSearchTypeAliases,
  supportedExaSearchTypes,
} from "./config";
import { supportedGeminiModels, supportedReasoningEfforts } from "./types";

const supportedGeminiModelSchema = z.enum(supportedGeminiModels);

export const reasoningEffortSchema = z.enum(supportedReasoningEfforts);

function resolveModel(
  raw: string | string[] | undefined,
): string | [string, string] {
  if (raw === undefined) {
    return defaultGeminiSettings.models.searchPlan;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return defaultGeminiSettings.models.searchPlan;
    if (!supportedGeminiModels.includes(trimmed as any)) {
      throw new Error(
        `The model field must be one of: ${supportedGeminiModels.join(", ")}.`,
      );
    }
    return trimmed;
  }
  if (raw.length !== 2) {
    throw new Error(
      "The model array must contain exactly two model IDs: search planning, then final answer.",
    );
  }
  const models = raw.map((m) => m.trim());
  for (const m of models) {
    if (!supportedGeminiModels.includes(m as any)) {
      throw new Error(
        `Each model array item must be one of: ${supportedGeminiModels.join(", ")}.`,
      );
    }
  }
  return [models[0], models[1]] as [string, string];
}

function resolveExaSearchType(raw: string | undefined): string {
  if (raw === undefined) return "auto";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return "auto";
  const alias = exaSearchTypeAliases[normalized];
  if (alias) return alias;
  if ((supportedExaSearchTypes as readonly string[]).includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `The searchType field must be one of: ${[
      ...Object.keys(exaSearchTypeAliases),
      ...supportedExaSearchTypes.filter((t) => !(t in exaSearchTypeAliases)),
    ].join(", ")}.`,
  );
}

export const factCheckJsonBodySchema = z
  .object({
    url: z.string().min(1, "The url field is required."),
    sourceType: z.enum(["auto", "video", "webpage"]).default("auto"),
    quality: z
      .enum(["best", "2160p", "1440p", "1080p", "720p", "480p", "360p"] as [
        string,
        ...string[],
      ])
      .default("1080p"),
    searchType: z.string().optional(),
    model: z.union([z.string(), z.array(z.string())]).optional(),
    reasoningEffort: z.string().optional(),
    effort: z.string().optional(),
    mode: z.enum(["direct", "queue"]).default("direct"),
    additionalContext: z.string().optional(),
    iosCompatible: z.boolean().default(true),
    proxy: z.boolean().default(false),
  })
  .transform((data) => {
    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(data.url);
    } catch {
      throw new Error("The url field must be a valid absolute URL.");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only http and https URLs are supported.");
    }

    // Validate model
    const resolvedModel = resolveModel(data.model);

    // Validate reasoning effort / effort consistency
    const rawReasoningEffort = data.reasoningEffort?.trim();
    const rawEffort = data.effort?.trim();
    if (
      rawReasoningEffort &&
      rawEffort &&
      rawReasoningEffort.toLowerCase() !== rawEffort.toLowerCase()
    ) {
      throw new Error(
        "The reasoningEffort and effort fields must match when both are provided.",
      );
    }

    const reasoningEffortInput = rawReasoningEffort || rawEffort;
    const reasoningEffort = reasoningEffortInput
      ? reasoningEffortInput.toLowerCase()
      : defaultGeminiSettings.reasoningEffort;

    if (!supportedReasoningEfforts.includes(reasoningEffort as any)) {
      throw new Error(
        `The reasoningEffort field must be one of: ${supportedReasoningEfforts.join(", ")}.`,
      );
    }

    const searchType = resolveExaSearchType(data.searchType);

    return {
      ...data,
      parsedUrl,
      resolvedModel,
      reasoningEffort: reasoningEffort as z.infer<typeof reasoningEffortSchema>,
      searchType,
    };
  });

export type FactCheckJsonBody = z.infer<typeof factCheckJsonBodySchema>;

export function formatZodErrors(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}
