import type { UrlSourceType } from "../types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isYoutubeUrl(url: URL | string): boolean {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return [
      "youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
    ].includes(host);
  } catch {
    return false;
  }
}

export function isKnownVideoPageUrl(url: URL | string): boolean {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.toLowerCase();

    if (/\.(mp4|mov|m4v|webm|m3u8)(?:$|\?)/i.test(path)) {
      return true;
    }

    return [
      "tiktok.com",
      "vm.tiktok.com",
      "instagram.com",
      "x.com",
      "twitter.com",
      "facebook.com",
      "fb.watch",
      "vimeo.com",
      "dailymotion.com",
      "twitch.tv",
    ].some((videoHost) => host === videoHost || host.endsWith(`.${videoHost}`));
  } catch {
    return false;
  }
}

export function resolveUrlProcessingMode(
  url: URL,
  sourceType: UrlSourceType,
  speed?: "fast" | "regular",
): "video" | "transcript" | "webpage" {
  if (sourceType === "webpage") {
    return "webpage";
  }

  if (speed === "fast") {
    return "transcript";
  }

  if (sourceType === "video") {
    return "video";
  }

  if (isYoutubeUrl(url)) {
    return "transcript";
  }

  return isKnownVideoPageUrl(url) ? "video" : "webpage";
}

export function parseRequestMode(
  rawMode: string | undefined,
): { mode: RequestMode } | { error: string } {
  const mode = rawMode?.trim().toLowerCase() || "direct";

  if (mode !== "direct" && mode !== "queue") {
    return { error: "The mode field must be either direct or queue." };
  }

  return { mode };
}

export function parseUrlSourceType(
  rawSourceType: string | undefined,
): { sourceType: UrlSourceType } | { error: string } {
  const sourceType = rawSourceType?.trim().toLowerCase() || "auto";

  if (
    sourceType !== "auto" &&
    sourceType !== "video" &&
    sourceType !== "webpage"
  ) {
    return {
      error: "The sourceType field must be one of: auto, video, webpage.",
    };
  }

  return { sourceType: sourceType as UrlSourceType };
}

export function parseExaSearchType(
  raw: string | undefined,
): { searchType: ExaSearchType } | { error: string } {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return { searchType: defaultExaSearchType };

  if (exaSearchTypeAliases[normalized]) {
    return { searchType: exaSearchTypeAliases[normalized] };
  }

  if ((supportedExaSearchTypes as readonly string[]).includes(normalized)) {
    return { searchType: normalized as ExaSearchType };
  }

  return {
    error: `The searchType field must be one of: ${Object.keys(
      exaSearchTypeAliases,
    )
      .concat(
        supportedExaSearchTypes.filter((t) => !(t in exaSearchTypeAliases)),
      )
      .join(", ")}.`,
  };
}

export function parseMultipartModelEntry(
  modelEntry: FormDataEntryValue | null,
): string | string[] | undefined {
  if (typeof modelEntry !== "string") {
    return undefined;
  }

  const trimmed = modelEntry.trim();

  if (!trimmed.startsWith("[")) {
    return modelEntry;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed)
      ? parsed.map((value) => String(value))
      : modelEntry;
  } catch {
    return modelEntry;
  }
}

export function parseGeminiOverrides(
  rawModel: string | string[] | undefined,
  rawEffort: string | undefined,
): GeminiRequestSettings | { error: string } {
  try {
    const model = normalizeRequestedModel(rawModel);
    const effort = rawEffort?.trim().toLowerCase()
      ? rawEffort.trim().toLowerCase()
      : defaultGeminiSettings.effort;

    return resolveGeminiSettings(model, effort);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Invalid Gemini model or effort.",
    };
  }
}
