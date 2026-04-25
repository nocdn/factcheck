# factcheck

A Bun + Hono API for fact-checking online videos with Gemini and Exa search evidence.

## What it does

`POST /api/check` accepts either:

- a public video page URL such as YouTube, TikTok, or another site supported by your downloader service
- a direct uploaded video file

When you send a URL, the API then:

1. Sends the source URL to `https://videos.bartoszbak.org/api/download` or your configured download endpoint.
2. Downloads a small MP4 into memory.
3. If the requested quality is unavailable from the downloader, retries once with `best`.
4. Sends the video to Gemini once to generate targeted Exa search queries.
5. Runs those searches through Exa with full-text page returns.
6. Sends the video and Exa search context to Gemini with:
   - `gemini-3-flash-preview` by default
   - high reasoning effort
   - `text/plain` output
7. Returns the plain-text fact-check result plus research sources, reasoning, and usage metadata.

When you send a direct file, the API skips the downloader completely and sends the uploaded video inline to Gemini.

Important: this implementation intentionally uses inline video bytes instead of Gemini's Files API. Because of that, downloaded or uploaded videos must stay under `INLINE_VIDEO_MAX_BYTES`, which defaults to `18874368` bytes, about 18 MiB.

## Setup

```sh
bun install
cp .env.example .env
```

Fill in `GEMINI_API_KEY` and `EXA_API_KEY` before calling `/api/check`.

## Development

```sh
bun run dev
```

The server listens on `http://localhost:7110` by default.

## Routes

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api` | Basic service metadata |
| `GET` | `/api/health` | Health check and Gemini config status |
| `POST` | `/api/check` | Download a video, send it to Gemini, and return a fact-check |

## `POST /api/check`

JSON request body for URL mode:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "quality": "1080p",
  "iosCompatible": true,
  "proxy": false,
  "additionalContext": "Pay extra attention to the health claims in the middle of the clip."
}
```

Fields:

- `url` is required and must be an absolute `http` or `https` URL.
- `quality` is optional. Supported values are `best`, `2160p`, `1440p`, `1080p`, `720p`, `480p`, and `360p`. If the downloader reports that the requested format is unavailable, the API retries once with `best`.
- `iosCompatible` is optional and defaults to `true`.
- `proxy` is optional and defaults to `false`.
- `additionalContext` is optional extra instruction text appended to the fact-check prompt.

Multipart form-data for file mode:

- `file` is required and must be a video file.
- `additionalContext` is optional.
- `url` is optional and can be used to preserve the original public page URL in the response and prompt context.

Example:

```bash
curl -X POST http://localhost:7110/api/check \
  -F "file=@/absolute/path/to/video.mp4" \
  -F "additionalContext=Pay extra attention to any medical claims." \
  -F "url=https://www.tiktok.com/@example/video/123"
```

Successful response shape:

```json
{
  "id": "abc123def456",
  "inputMode": "url",
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": "gemini-3-flash-preview",
  "analysis": "Plain text fact-check response from Gemini.",
  "reasoning": "Optional Gemini thought text if returned by the API.",
  "download": {
    "apiUrl": "https://videos.bartoszbak.org/api/download",
    "filename": "video.mp4",
    "mimeType": "video/mp4",
    "quality": "1080p",
    "requestedQuality": "1080p",
    "sizeBytes": 1234567,
    "iosCompatible": true,
    "proxy": false
  },
  "uploadedFile": null,
  "research": {
    "provider": "exa",
    "searchType": "auto",
    "queries": [
      {
        "query": "specific search query",
        "rationale": "Why this query is needed."
      }
    ],
    "results": [
      {
        "query": "specific search query",
        "title": "Example source",
        "url": "https://example.com",
        "publishedDate": "2026-01-01",
        "author": "Example Author"
      }
    ]
  },
  "usage": {
    "promptTokenCount": 1000,
    "candidatesTokenCount": 800,
    "thoughtsTokenCount": 300,
    "toolUsePromptTokenCount": 200,
    "totalTokenCount": 2300
  },
  "warnings": []
}
```

Common error cases:

- `400` invalid request body or unsupported `quality`
- `413` downloaded or uploaded video exceeds `INLINE_VIDEO_MAX_BYTES`
- `502` upstream downloader, Exa, or Gemini failure
- `504` upstream timeout
- `500` missing Gemini configuration or unexpected server error

## Gemini behavior

The prompt instructs Gemini to:

- watch the full video
- identify material factual claims
- generate the configured number of targeted Exa searches in a first model pass
- use Exa full-text search results as supporting evidence in the final model pass
- avoid near-duplicate searches when possible while allowing overlap for very specific topics
- distinguish historically supported origin claims from widely repeated but uncertain origin stories
- call out false, misleading, missing-context, or unverifiable claims
- return plain text only with no markdown, use inline references in the analysis (`[1]` for one source, `[1][2][3]` for several—adjacent brackets, not `[1, 2, 3]`), then end with `Sources:` (`[1] - https://...` one URL per line) followed by `Searches:` (one raw query per line)

The implementation enables:

- `thinkingConfig.thinkingLevel = HIGH`
- `thinkingConfig.includeThoughts = true`
- `responseMimeType = "text/plain"`

The server also emits verbose logs for each request, including request settings, downloader activity, generated Exa queries, Exa sources, Gemini request settings, finish reasons, token usage, returned analysis, and any thought text returned by the SDK.

## Environment variables

All variables are optional unless marked required.

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `PORT` | Port the API listens on | `7110` |
| `RATE_LIMIT_WINDOW_MS` | `/api/check` global rate limit window in ms | `86400000` |
| `RATE_LIMIT_MAX` | Max `/api/check` requests per main window across all callers | `10` |
| `HEALTH_RATE_LIMIT_WINDOW_MS` | Health endpoint rate limit window in ms | `500` |
| `HEALTH_RATE_LIMIT_MAX` | Max requests per health window | `1` |
| `GEMINI_API_KEY` | Gemini Developer API key | required for `/api/check` |
| `GEMINI_MODEL` | Gemini model used for fact-checking | `gemini-3-flash-preview` |
| `GEMINI_TIMEOUT_MS` | Gemini request timeout in ms | `300000` |
| `FACT_CHECK_MAX_OUTPUT_TOKENS` | Max output tokens requested from Gemini, including thinking tokens | `32768` |
| `FACT_CHECK_SEARCH_PLAN_MAX_OUTPUT_TOKENS` | Max output tokens requested when Gemini plans Exa searches | `2048` |
| `EXA_API_KEY` | Exa API key used for web evidence searches | required for `/api/check` |
| `EXA_SEARCH_TYPE` | Exa search type used for generated queries | `auto` |
| `EXA_SEARCH_QUERY_COUNT` | Number of generated Exa searches per fact-check, clamped from 1 to 10 | `3` |
| `EXA_SEARCH_RESULTS_PER_QUERY` | Exa results retrieved per generated query, clamped from 1 to 10 | `6` |
| `EXA_SEARCH_TEXT_MAX_CHARACTERS` | Max full-text characters returned per Exa result | `35000` |
| `EXA_SEARCH_TIMEOUT_MS` | Exa search timeout in ms | `60000` |
| `VIDEO_DOWNLOAD_API_URL` | Upstream download endpoint | `https://videos.bartoszbak.org/api/download` |
| `FACT_CHECK_DEFAULT_QUALITY` | Default download quality | `1080p` |
| `VIDEO_DOWNLOAD_TIMEOUT_MS` | Video download timeout in ms | `120000` |
| `INLINE_VIDEO_MAX_BYTES` | Max downloaded video size allowed before the API refuses inline Gemini upload | `18874368` |

## Rate limiting

Rate limiting is handled by `hono-rate-limiter`. Limits are global for the whole app, not per IP or per user.

Two separate limiters are configured:

- Main: covers `/api/check` only with one shared global bucket across all callers
- Health: covers `/api/health` only

## Docker

The image copies `bun.lock` for reproducible `bun install` in the build. Keep `bun.lock` committed when you change dependencies.

```sh
docker compose up --build
```
