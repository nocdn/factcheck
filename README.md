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
   - `gemini-3-flash-preview` by default, or request overrides of `gemini-3-flash-preview` / `gemini-3.1-flash-lite-preview`
   - the request's `reasoningEffort` when provided, otherwise `REASONING_EFFORT`
   - `text/plain` output
7. Returns the plain-text fact-check result plus research sources, reasoning, and usage metadata, either in the same request or through a queued job depending on `mode`.

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
| `POST` | `/api/check` | Download a video, send it to Gemini, and return a fact-check directly or queue a background job |
| `GET` | `/api/check/:jobId` | Poll a queued fact-check job |

## `POST /api/check`

JSON request body for URL mode:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "quality": "1080p",
  "iosCompatible": true,
  "proxy": false,
  "additionalContext": "Pay extra attention to the health claims in the middle of the clip.",
  "model": "gemini-3-flash-preview",
  "effort": "high",
  "mode": "direct"
}
```

Fields:

- `url` is required and must be an absolute `http` or `https` URL.
- `quality` is optional. Supported values are `best`, `2160p`, `1440p`, `1080p`, `720p`, `480p`, and `360p`. If the downloader reports that the requested format is unavailable, the API retries once with `best`.
- `iosCompatible` is optional and defaults to `true`.
- `proxy` is optional and defaults to `false`.
- `additionalContext` is optional extra instruction text appended to the fact-check prompt.
- `model` is optional. Supported values are `gemini-3-flash-preview` and `gemini-3.1-flash-lite-preview`. If omitted, the API uses `GEMINI_MODEL` for both Gemini steps. Send a string to use one model for both steps, or send a two-item array where the first model is used for the video watch/search-query planning step and the second model is used for the final answer synthesis step.
- `reasoningEffort` is optional. `effort` is an alias for the same setting. Supported values are `minimal`, `low`, `medium`, and `high`. If both are provided they must match. If neither is provided, the API uses `REASONING_EFFORT`.
- `mode` is optional and defaults to `direct`. Use `direct` to keep the HTTP request open until the fact-check is complete. Use `queue` to return an 8-digit job ID immediately and run the same fact-check in the background.

Model array example:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"],
  "reasoningEffort": "high"
}
```

Multipart form-data for file mode:

- `file` is required and must be a video file.
- `additionalContext` is optional.
- `url` is optional and can be used to preserve the original public page URL in the response and prompt context.
- `model` is optional and follows the same allowed values as JSON mode. For multipart requests, pass the two-model form as a JSON array string, for example `["gemini-3-flash-preview","gemini-3.1-flash-lite-preview"]`.
- `reasoningEffort` is optional in multipart mode, and `effort` is an alias for it.
- `mode` is optional in multipart mode and follows the same `direct` or `queue` behavior as JSON mode.

Example:

```bash
curl -X POST http://localhost:7110/api/check \
  -F "file=@/absolute/path/to/video.mp4" \
  -F "additionalContext=Pay extra attention to any medical claims." \
  -F "model=gemini-3.1-flash-lite-preview" \
  -F "effort=medium" \
  -F "mode=direct" \
  -F "url=https://www.tiktok.com/@example/video/123"
```

Successful direct response shape:

```json
{
  "id": "abc123def456",
  "inputMode": "url",
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": "gemini-3-flash-preview",
  "models": {
    "searchPlan": "gemini-3-flash-preview",
    "finalAnswer": "gemini-3-flash-preview"
  },
  "reasoningEffort": "high",
  "analysis": "Confidence: 7/10\n\nExplanation:\nOverall verdict sentence.\nSummary paragraph.\nDetailed fact-check paragraphs with inline citations like [1][2].\n\nSources:\n[1] - https://example.com/source\n\nSearches:\n(1) - example search query",
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

Queued request example:

```bash
curl -X POST http://localhost:7110/api/check \
  -H "content-type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "mode": "queue",
    "model": ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"],
    "reasoningEffort": "high"
  }'
```

Queued response shape:

```json
{
  "id": "12345678",
  "ready": false
}
```

Poll the job with:

```bash
curl http://localhost:7110/api/check/12345678
```

If the job is still processing, the API returns:

```json
{
  "id": "12345678",
  "ready": false
}
```

If the job is complete, the API returns `ready: true` plus the same fact-check JSON fields returned by direct mode:

```json
{
  "ready": true,
  "id": "12345678",
  "inputMode": "url",
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "model": ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"],
  "models": {
    "searchPlan": "gemini-3-flash-preview",
    "finalAnswer": "gemini-3.1-flash-lite-preview"
  },
  "reasoningEffort": "high",
  "analysis": "Confidence: 7/10\n\nExplanation:\n...",
  "reasoning": null,
  "download": {},
  "uploadedFile": null,
  "research": {},
  "usage": {},
  "warnings": []
}
```

Common error cases:

- `400` invalid request body or unsupported `quality`, `model`, `reasoningEffort`, or `effort`
- `404` unknown queued job ID
- `413` downloaded or uploaded video exceeds `INLINE_VIDEO_MAX_BYTES`
- `502` upstream downloader, Exa, or Gemini failure
- `503` Gemini remains unavailable after high-demand retries
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
- start with a calibrated `Confidence: X/10` line using a realistic, non-extreme score unless the evidence clearly warrants it
- add an `Explanation:` section with the verdict, summary, and detailed claim-by-claim analysis using inline references (`[1]` for one source, `[1][2][3]` for several—adjacent brackets, not `[1, 2, 3]`)
- end with `Sources:` (`[1] - https://...` one URL per line) followed by `Searches:` (`(1) - query text`, `(2) - query text`, and so on)

The implementation enables:

- request-selectable `thinkingConfig.thinkingLevel` based on `reasoningEffort`
- `thinkingConfig.includeThoughts = true`
- `responseMimeType = "text/plain"`
- separate request-selectable Gemini models for the search-planning step and final-answer step when `model` is a two-item array
- a configurable delay before the final Gemini synthesis request, defaulting to 10 seconds
- two automatic retries by default when Gemini returns the temporary high-demand 503 response

Supported Gemini request settings:

- Models: `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`. Use a single string for both Gemini calls, or `[searchPlanningModel, finalAnswerModel]` to split them by step.
- Reasoning effort: `minimal`, `low`, `medium`, `high` via `reasoningEffort` or `effort`

If a request omits `model` or `reasoningEffort`, the API falls back to `GEMINI_MODEL` and `REASONING_EFFORT`. The same reasoning effort is used for both Gemini calls.

The server also emits verbose logs for each request, including request settings, downloader activity, generated Exa queries, Exa sources, Gemini request settings, finish reasons, token usage, returned analysis, and any thought text returned by the SDK.

If Gemini returns a temporary high-demand 503, the API waits `GEMINI_HIGH_DEMAND_RETRY_DELAY_MS` and retries up to `GEMINI_HIGH_DEMAND_RETRY_COUNT` times. If all retries fail, direct mode returns `503`; queued mode stores the failed job and polling returns `ready: true` with the error.

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
| `GEMINI_MODEL` | Default Gemini model used when the request body omits `model` | `gemini-3-flash-preview` |
| `REASONING_EFFORT` | Default Gemini reasoning effort used when the request body omits `reasoningEffort` | `high` |
| `GEMINI_TIMEOUT_MS` | Gemini request timeout in ms | `300000` |
| `GEMINI_STEP_DELAY_MS` | Delay before the final Gemini synthesis request, after search planning and Exa search complete | `10000` |
| `GEMINI_HIGH_DEMAND_RETRY_COUNT` | Number of retries for temporary Gemini high-demand 503 responses | `2` |
| `GEMINI_HIGH_DEMAND_RETRY_DELAY_MS` | Delay before each Gemini high-demand retry in ms | `10000` |
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
