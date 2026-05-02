import { z } from "zod";
import {
  defaultGeminiSettings,
  defaultOpenAiSettings,
  exaSearchTypeAliases,
  supportedExaSearchTypes,
} from "./config";
import {
  supportedGeminiModels,
  supportedModelProviders,
  supportedOpenAiModels,
  supportedEfforts,
  type ModelProvider,
} from "./types";

export const effortSchema = z.enum(supportedEfforts);

function resolveModel(
  raw: string | string[] | undefined,
  provider: ModelProvider,
): string | [string, string] {
  const supportedModels =
    provider === "openai" ? supportedOpenAiModels : supportedGeminiModels;
  const defaultModel =
    provider === "openai"
      ? defaultOpenAiSettings.models.searchPlan
      : defaultGeminiSettings.models.searchPlan;

  if (raw === undefined) {
    return defaultModel;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return defaultModel;
    if (!supportedModels.includes(trimmed as any)) {
      throw new Error(
        `The model field must be one of these ${provider === "openai" ? "OpenAI" : "Gemini"} models: ${supportedModels.join(", ")}.`,
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
    if (!supportedModels.includes(m as any)) {
      throw new Error(
        `Each model array item must be one of these ${provider === "openai" ? "OpenAI" : "Gemini"} models: ${supportedModels.join(", ")}.`,
      );
    }
  }
  return [models[0], models[1]] as [string, string];
}

function resolveProvider(raw: string | undefined): ModelProvider {
  const normalized = raw?.trim().toLowerCase();

  if (!normalized) {
    return "openai";
  }

  if (normalized === "gemini") {
    return "google";
  }

  if ((supportedModelProviders as readonly string[]).includes(normalized)) {
    return normalized as ModelProvider;
  }

  throw new Error("The provider field must be one of: google, gemini, openai.");
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
    provider: z.string().optional(),
    model: z.union([z.string(), z.array(z.string())]).optional(),
    effort: z.string().optional(),
    reasoningEffort: z
      .never({ error: "The reasoningEffort field is not supported. Use effort." })
      .optional(),
    mode: z.enum(["direct", "queue"]).default("direct"),
    speed: z.enum(["fast", "regular"]).default("fast"),
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

    const provider = resolveProvider(data.provider);

    // Validate model against the selected provider.
    const resolvedModel = resolveModel(data.model, provider);

    // Validate effort.
    const rawEffort = data.effort?.trim();
    const effort = rawEffort
      ? rawEffort.toLowerCase()
      : provider === "openai"
        ? defaultOpenAiSettings.effort
        : defaultGeminiSettings.effort;

    if (!supportedEfforts.includes(effort as any)) {
      throw new Error(
        `The effort field must be one of: ${supportedEfforts.join(", ")}.`,
      );
    }

    const searchType = resolveExaSearchType(data.searchType);

    return {
      ...data,
      parsedUrl,
      provider,
      resolvedModel,
      effort: effort as z.infer<typeof effortSchema>,
      searchType,
    };
  });

export type FactCheckJsonBody = z.infer<typeof factCheckJsonBodySchema>;

export function formatZodErrors(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}
