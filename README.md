# factcheck

A Bun + Hono API for fact-checking online videos, YouTube transcripts, and normal articles/webpages with Gemini and Exa search evidence.

## What it does

`POST /api/check` accepts either:

- a public video page URL such as YouTube, TikTok, or another site supported by your downloader service
- a public article or normal webpage URL
- a direct uploaded video file

URL mode automatically chooses a flow based on `sourceType` and the URL host. `sourceType` defaults to `auto`; use `video` to force the downloader for a non-standard video URL, or `webpage` to force Exa Contents for a normal page.

### Default URL flow (TikTok, Instagram, X, and other non-YouTube hosts)

1. Sends the source URL to `https://videos.bartoszbak.org/api/download` or your configured download endpoint with `mode=both`.
2. Downloads a small MP4 into memory.
3. If the requested quality is unavailable from the downloader, retries once with `best`.
4. Sends the video to Gemini once to generate up to `SOCIALS_MAX_SEARCHES` targeted Exa search queries (default 5).
5. Runs those searches through Exa with `SOCIALS_RESULTS_PER_SEARCH` full-text page returns per query (default 5).
6. Sends the video and Exa search context to Gemini with:
   - `gemini-3-flash-preview` by default, or request overrides of `gemini-3-flash-preview` / `gemini-3.1-flash-lite-preview`
   - the request's `reasoningEffort` when provided, otherwise `REASONING_EFFORT`
   - `text/plain` output
7. Returns the plain-text fact-check result plus research sources, reasoning, and usage metadata, either in the same request or through a queued job depending on `mode`.

### Webpage/article URL flow

When `sourceType` is `webpage`, or when `sourceType` is `auto` and the URL is not a known video host, the API fact-checks the page as an article:

1. Sends the URL to Exa's `/contents` endpoint with `text=true` to retrieve clean article/page text.
2. Sends the article text to Gemini to generate up to `ARTICLE_MAX_SEARCHES` targeted Exa search queries (default 7).
3. Runs those searches through Exa with `ARTICLE_RESULTS_PER_SEARCH` full-text page returns per query (default 4), excluding the original article URL as corroborating evidence.
4. Sends the article text plus the Exa search context to Gemini for the final fact-check synthesis.
5. Returns the same response shape as the video flow, with `download` and `transcription` set to `null` and `webpage` populated with source-page metadata.

### YouTube URL flow (transcript-based)

When the request URL is a YouTube URL (`youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`, or `youtube-nocookie.com`), the API switches to a transcript-based flow that better tolerates long videos:

1. Sends the source URL to the download endpoint with `mode=audio` and `audioQuality=YOUTUBE_AUDIO_QUALITY` (default `low`) and downloads an MP3 into memory. Lower bitrates are used by default so most YouTube videos stay under Cohere's 25 MB upload limit.
2. Uploads the MP3 to Cohere's `/v2/audio/transcriptions` endpoint and receives the transcript text.
3. Sends only the transcript to Gemini and asks it to generate up to `YOUTUBE_MAX_SEARCHES` targeted Exa search queries (default 10), covering as many distinct important claims as possible.
4. Runs those searches through Exa, returning `YOUTUBE_RESULTS_PER_SEARCH` full-text results per query (default 3).
5. Sends the transcript plus the Exa search context to Gemini for the final fact-check synthesis.
6. Returns the same response shape as the default URL flow, with `download` set to `null`, the new `transcription` field populated, and the audio download metadata included on `transcription.audio`.

The raw audio is never sent to Gemini in this flow. Gemini receives only text.

### File upload mode

When you send a direct file, the API skips the downloader completely and sends the uploaded video inline to Gemini.

Important: the default and file flows intentionally use inline video bytes instead of Gemini's Files API. Because of that, downloaded or uploaded videos must stay under `INLINE_VIDEO_MAX_BYTES`, which defaults to `18874368` bytes, about 18 MiB. The YouTube transcript flow uploads to Cohere instead and is bounded by `YOUTUBE_AUDIO_MAX_BYTES`, which defaults to 25 MiB to match Cohere's audio upload limit.

## Setup

```sh
bun install
cp .env.example .env
```

Fill in `GEMINI_API_KEY` and `EXA_API_KEY` before calling `/api/check`. Set `COHERE_API_KEY` as well if you want YouTube transcript fact-checks; without it, requests for YouTube URLs will fail with `500`.

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
| `POST` | `/api/check` | Fact-check a video, YouTube transcript, article, webpage, or uploaded video directly or through a queued job |
| `GET` | `/api/check/:jobId` | Poll a queued fact-check job |

## `POST /api/check`

JSON request body for URL mode:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "sourceType": "auto",
  "quality": "1080p",
  "iosCompatible": true,
  "proxy": false,
  "additionalContext": "Pay extra attention to the health claims in the middle of the clip.",
  "model": "gemini-3-flash-preview",
  "effort": "high",
  "searchType": "deep",
  "mode": "direct"
}
```

Fields:

- `url` is required and must be an absolute `http` or `https` URL.
- `sourceType` is optional and defaults to `auto`. Supported values are `auto`, `video`, and `webpage`. In `auto`, YouTube uses the transcript flow, known social/video hosts use the video downloader flow, and ordinary URLs use the webpage/article flow.
- `quality` is optional. Supported values are `best`, `2160p`, `1440p`, `1080p`, `720p`, `480p`, and `360p`. If the downloader reports that the requested format is unavailable, the API retries once with `best`.
- `iosCompatible` is optional and defaults to `true`.
- `proxy` is optional and defaults to `false`.
- `additionalContext` is optional extra instruction text appended to the fact-check prompt.
- `model` is optional. Supported values are `gemini-3-flash-preview` and `gemini-3.1-flash-lite-preview`. If omitted, the API uses `GEMINI_MODEL` for both Gemini steps. Send a string to use one model for both steps, or send a two-item array where the first model is used for search-query planning and the second model is used for final answer synthesis.
- `reasoningEffort` is optional. `effort` is an alias for the same setting. Supported values are `minimal`, `low`, `medium`, and `high`. If both are provided they must match. If neither is provided, the API uses `REASONING_EFFORT`.
- `searchType` is optional and defaults to `EXA_SEARCH_TYPE` (default `auto`). Controls the Exa search algorithm used for evidence retrieval. Supported aliases are `instant` (lowest latency), `deep` (deeper search), and `reasoning` (maps to Exa's `deep-reasoning`). You can also pass any raw Exa value directly: `auto`, `neural`, `fast`, `deep-lite`, `deep`, `deep-reasoning`, `instant`.
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
- `searchType` is optional in multipart mode and follows the same behavior as JSON mode.
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
  "transcription": null,
  "webpage": null,
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
  "transcription": null,
  "webpage": null,
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

- watch the full video, read the YouTube transcript, or read the article/webpage depending on the selected URL flow
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

For YouTube URLs, Gemini receives only the Cohere-generated transcript (and later, the Exa search context). The raw audio is sent to Cohere, never to Gemini. The first Gemini call is asked to produce up to `YOUTUBE_MAX_SEARCHES` queries (default 10) sized to the actual number of distinct claims in the transcript, and the second Gemini call synthesizes the final fact-check from the transcript plus full-text Exa results.

For webpage/article URLs, Exa Contents retrieves clean page text before Gemini planning. The original article is treated as the primary claim source, not independent evidence, and its URL is excluded from the follow-up Exa search results used for corroboration.

All Exa text passed to Gemini is full page text, not snippets or highlights. Search evidence uses Exa `contents.text.maxCharacters` with `EXA_SEARCH_TEXT_MAX_CHARACTERS`; article/webpage source text fetched from Exa Contents is locally capped with the same limit.

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
| `EXA_SEARCH_TYPE` | Default Exa search type used when the request body omits `searchType`. Accepts `auto`, `neural`, `fast`, `deep-lite`, `deep`, `deep-reasoning`, `instant`, and the request aliases `instant`, `deep`, `reasoning` (which maps to `deep-reasoning`). | `auto` |
| `SOCIALS_MAX_SEARCHES` | Max Exa searches Gemini may generate for social/video URL fact-checks, clamped from 1 to 10 | `5` |
| `SOCIALS_RESULTS_PER_SEARCH` | Exa full-text results retrieved per social/video search, clamped from 1 to 10 | `5` |
| `YOUTUBE_MAX_SEARCHES` | Max Exa searches Gemini may generate for YouTube transcript fact-checks, clamped from 1 to 20 | `10` |
| `YOUTUBE_RESULTS_PER_SEARCH` | Exa full-text results retrieved per YouTube search, clamped from 1 to 10 | `3` |
| `ARTICLE_MAX_SEARCHES` | Max Exa searches Gemini may generate for article/webpage fact-checks, clamped from 1 to 10 | `7` |
| `ARTICLE_RESULTS_PER_SEARCH` | Exa full-text results retrieved per article/webpage search, clamped from 1 to 10 | `4` |
| `EXA_SEARCH_TEXT_MAX_CHARACTERS` | Max full-text characters passed to Gemini per Exa result or source webpage | `35000` |
| `EXA_SEARCH_TIMEOUT_MS` | Exa search timeout in ms | `60000` |
| `COHERE_API_KEY` | Cohere API key used to transcribe YouTube audio | required for YouTube `/api/check` |
| `COHERE_TRANSCRIBE_MODEL` | Cohere transcription model | `cohere-transcribe-03-2026` |
| `COHERE_TRANSCRIBE_LANGUAGE` | ISO-639-1 language code passed to Cohere | `en` |
| `COHERE_TRANSCRIBE_TIMEOUT_MS` | Cohere transcription timeout in ms | `300000` |
| `YOUTUBE_AUDIO_QUALITY` | `audioQuality` preset or raw bitrate sent to the downloader for YouTube audio. Accepts `best`, `high`, `medium`, `low`, `lowest`, or a bitrate like `96K`, `128K`, `192K`. Lower values keep more long videos under Cohere's 25 MB upload limit. | `low` |
| `VIDEO_DOWNLOAD_API_URL` | Upstream download endpoint | `https://videos.bartoszbak.org/api/download` |
| `FACT_CHECK_DEFAULT_QUALITY` | Default download quality | `1080p` |
| `VIDEO_DOWNLOAD_TIMEOUT_MS` | Video or audio download timeout in ms | `120000` |
| `INLINE_VIDEO_MAX_BYTES` | Max downloaded video size allowed before the API refuses inline Gemini upload | `18874368` |
| `YOUTUBE_AUDIO_MAX_BYTES` | Max downloaded YouTube audio size allowed before the API refuses to forward it to Cohere. Cohere itself caps audio uploads at 25 MB, so keep this at or below `26214400`. | `26214400` |

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
