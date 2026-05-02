FACTCHECK
=========

Video, transcript, and article fact-checking API powered by Gemini or OpenAI
models and Exa search evidence.

Routes

| Method | Path            | Description                         |
| ------ | --------------- | ----------------------------------- |
| GET    | /api/health     | service status and configuration    |
| GET    | /               | this page                           |
| POST   | /api/check      | run a fact-check (direct or queued) |
| GET    | /api/check/:id  | poll a queued job                   |

POST /api/check — URL mode

curl -X POST http://localhost:{PORT}/api/check \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://www.tiktok.com/@user/video/123",
    "searchType": "deep",
    "effort": "high",
    "mode": "direct"
  }'

By default, video URLs are processed in fast transcript mode with OpenAI:
audio download, Cohere transcription, then OpenAI text analysis with Exa
evidence. To send social-media videos (TikTok, Instagram, X, etc.) to Gemini as
inline video data, set `provider: "google"` or `provider: "gemini"` and
`speed: "regular"`. If Gemini inline video fails, the request is retried once
more with the same inline-video approach. If it fails again, a final fallback
attempts transcription-based fact-checking. Transcript paths require
`COHERE_API_KEY`.

speed

When `speed` is set to `fast`, every non-webpage URL is processed as a
transcript instead of raw inline video, no matter which platform it points to.
This skips the inline-video path entirely and downloads audio for transcription
via Cohere. `fast` is the default. `regular` enables Gemini raw inline-video
processing for social-media URLs only when `provider` is also `google` or
`gemini`; OpenAI regular video requests return an error. YouTube URLs are always
transcribed regardless of this setting. Articles (`sourceType: webpage`) are
never affected by `speed`.

provider

`provider` selects the model provider used for search planning and final
fact-check synthesis. The default is `openai`. `google` and `gemini` both use
Gemini models. `openai` uses OpenAI Responses API models. The `model` field is
validated against the selected provider, so OpenAI requests can only use
supported OpenAI model IDs and Gemini requests can only use supported Gemini
model IDs.

OpenAI models do not ingest video directly in this API. For video URLs,
`provider: "openai"` requires `speed: "fast"` (also the default) so the source
is processed as audio transcription via Cohere before OpenAI receives text.
OpenAI is rejected for multipart video uploads; set `provider: "google"` or
`provider: "gemini"` for direct video upload fact-checking. Article/webpage
requests can use OpenAI because they are already text-based.

Raw inline-video mode requires `provider: "google"` or `provider: "gemini"` and
`speed: "regular"`. Requests that try raw video mode with `provider: "openai"`
return an error.

Pro-tier OpenAI model IDs are intentionally not allowed for fact-checking.
Supported OpenAI models are `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.4-nano`, `gpt-5.2`, `gpt-5`, `gpt-5-mini`, and `gpt-5-nano`.

curl -X POST http://localhost:{PORT}/api/check \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://www.tiktok.com/@user/video/123",
    "provider": "openai",
    "speed": "fast",
    "model": "gpt-5.5",
    "searchType": "deep",
    "mode": "direct"
  }'

curl -X POST http://localhost:{PORT}/api/check \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "searchType": "reasoning",
    "mode": "queue"
  }'

curl -X POST http://localhost:{PORT}/api/check \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com/article.html",
    "sourceType": "webpage",
    "searchType": "instant",
    "mode": "direct"
  }'

POST /api/check — file upload mode

curl -X POST http://localhost:{PORT}/api/check \
  -F 'file=@/path/to/video.mp4' \
  -F 'provider=google' \
  -F 'searchType=deep' \
  -F 'effort=high' \
  -F 'mode=direct' \
  -F 'url=https://www.tiktok.com/@user/video/123'

Queue polling

curl http://localhost:{PORT}/api/check/12345678

Request fields

| Field             | Type    | Default  | Description                                          |
| ----------------- | ------- | -------- | ---------------------------------------------------- |
| url               | string  | —        | required in JSON; optional in file mode             |
| sourceType        | string  | auto     | auto, video, webpage                                 |
| provider          | string  | openai   | openai, google, or gemini                            |
| quality           | string  | 1080p    | best, 2160p, 1440p, 1080p, 720p, 480p, 360p          |
| searchType        | string  | auto     | instant, deep, reasoning (or raw Exa values)         |
| model             | string  | env      | model ID from the selected provider's allow-list     |
| effort            | string  | provider | provider-specific effort                             |
| mode              | string  | direct   | direct (wait) or queue (return job id)               |
| speed             | string  | fast     | fast (always transcribe) or regular (inline video)   |
| additionalContext | string  | —        | optional extra instructions for the prompt          |
| iosCompatible     | boolean | true     | passed to downloader                                 |
| proxy             | boolean | false    | passed to downloader                                 |

searchType values

| Alias     | Exa value       | Description                            |
| --------- | --------------- | -------------------------------------- |
| instant   | instant         | lowest latency, real-time optimized    |
| deep      | deep            | light deep search                      |
| reasoning | deep-reasoning  | base deep search                       |

Also accepts raw Exa values directly: auto, neural, fast, deep-lite, deep, deep-reasoning, instant.

Response fields

| Field             | Description                                           |
| ----------------- | ----------------------------------------------------- |
| id                | request or job id                                     |
| inputMode         | url or file                                           |
| url               | source url if provided                                |
| provider          | google or openai                                      |
| model             | model string or array used                            |
| models            | { searchPlan, finalAnswer }                           |
| effort            | provider-specific effort                              |
| analysis          | plain-text fact-check with Confidence: X/10           |
| reasoning         | Gemini thinking text when available                   |
| download          | downloader metadata (URL mode only)                   |
| uploadedFile      | file metadata (upload mode only)                      |
| transcription     | Cohere transcript + audio metadata (YouTube and social-media fallback) |
| webpage           | Exa article metadata (article mode only)              |
| research          | Exa queries, searchType used, and full-text results   |
| usage             | prompt, candidate, thought, and total tokens          |
| warnings          | array of informative warnings                         |

Environment

| Variable                                 | Required | Description                                          | Default                                    |
| ---------------------------------------- | -------- | ---------------------------------------------------- | ------------------------------------------ |
| GEMINI_API_KEY                           | yes*     | Gemini Developer API key for provider=google/gemini  | —                                          |
| OPENAI_API_KEY                           | yes*     | OpenAI API key for provider=openai requests          | —                                          |
| EXA_API_KEY                              | yes      | Exa API key                                          | —                                          |
| COHERE_API_KEY                           | yes*     | Cohere API key for transcription (YouTube and social-media fallback) | —                                          |
| GEMINI_MODEL                             | no       | default model                                        | gemini-3-flash-preview                     |
| OPENAI_MODEL                             | no       | default OpenAI model for provider=openai             | gpt-5.5                                    |
| EFFORT                                   | no       | default Gemini effort                                | high                                       |
| OPENAI_EFFORT                            | no       | default OpenAI effort                                | medium                                     |
| EXA_SEARCH_TYPE                          | no       | default searchType                                   | auto                                       |
| PORT                                     | no       | port the API listens on                              | {PORT}                                     |
| VIDEO_DOWNLOAD_API_URL                   | no       | upstream downloader endpoint                         | https://videos.bartoszbak.org/api/download |
| FACT_CHECK_DEFAULT_QUALITY               | no       | default download quality                             | 1080p                                      |
| VIDEO_DOWNLOAD_TIMEOUT_MS                | no       | video or audio download timeout (ms)                 | 120000                                     |
| INLINE_VIDEO_MAX_BYTES                   | no       | max downloaded video size (bytes)                    | 18874368                                   |
| YOUTUBE_AUDIO_MAX_BYTES                  | no       | max YouTube audio size for Cohere (bytes)            | 26214400                                   |
| YOUTUBE_AUDIO_QUALITY                    | no       | YouTube audio quality or bitrate                     | low                                        |
| GEMINI_TIMEOUT_MS                        | no       | Google provider model request timeout (ms)           | 300000                                     |
| OPENAI_TIMEOUT_MS                        | no       | OpenAI provider model request timeout (ms)           | 300000                                     |
| GEMINI_STEP_DELAY_MS                     | no       | delay before final provider synthesis (ms)           | 10000                                      |
| GEMINI_HIGH_DEMAND_RETRY_COUNT           | no       | retries for Gemini 503 high-demand                   | 2                                          |
| GEMINI_HIGH_DEMAND_RETRY_DELAY_MS        | no       | delay before each Gemini high-demand retry (ms)      | 10000                                      |
| MAX_OUTPUT_TOKENS                        | no       | max provider output tokens for final response        | 32768                                      |
| SEARCH_PLAN_MAX_OUTPUT_TOKENS            | no       | max provider output tokens for search plan generation | 2048                                      |
| SOCIALS_MAX_SEARCHES                     | no       | max Exa searches for social/video (1–10)             | 5                                          |
| SOCIALS_RESULTS_PER_SEARCH               | no       | Exa results per social/video search (1–10)           | 5                                          |
| YOUTUBE_MAX_SEARCHES                     | no       | max Exa searches for YouTube (1–20)                  | 10                                         |
| YOUTUBE_RESULTS_PER_SEARCH               | no       | Exa results per YouTube search (1–10)                | 3                                          |
| ARTICLE_MAX_SEARCHES                     | no       | max Exa searches for article/webpage (1–10)          | 7                                          |
| ARTICLE_RESULTS_PER_SEARCH               | no       | Exa results per article/webpage search (1–10)        | 4                                          |
| EXA_SEARCH_TEXT_MAX_CHARACTERS           | no       | max chars per Exa result or source webpage           | 35000                                      |
| EXA_SEARCH_TIMEOUT_MS                    | no       | Exa search timeout (ms)                              | 60000                                      |
| EXA_RETRY_COUNT                          | no       | Exa retry count                                      | 2                                          |
| EXA_RETRY_DELAY_MS                       | no       | Exa retry delay (ms)                                 | 5000                                       |
| DOWNLOADER_RETRY_COUNT                   | no       | downloader retry count                               | 2                                          |
| DOWNLOADER_RETRY_DELAY_MS                | no       | downloader retry delay (ms)                          | 5000                                       |
| COHERE_TRANSCRIBE_MODEL                  | no       | Cohere transcription model                           | cohere-transcribe-03-2026                  |
| COHERE_TRANSCRIBE_LANGUAGE               | no       | ISO-639-1 language code                              | en                                         |
| COHERE_TRANSCRIBE_TIMEOUT_MS             | no       | Cohere transcription timeout (ms)                    | 300000                                     |
| COHERE_RETRY_COUNT                       | no       | Cohere retry count                                   | 2                                          |
| COHERE_RETRY_DELAY_MS                    | no       | Cohere retry delay (ms)                              | 5000                                       |
| DIRECT_MODE_TIMEOUT_MS                   | no       | timeout for direct-mode requests (ms)                | 600000                                     |
| LOG_LEVEL                                | no       | pino log level (trace, debug, info, warn, error)     | info (production), debug (development)     |
| NODE_ENV                                 | no       | set to `production` for JSON logs; dev gets color    | —                                          |
| PRETTY_LOGS                              | no       | `true` forces colorized pretty logs, `false` forces JSON | auto (JSON in production, pretty in dev) |

* GEMINI_API_KEY required only when `provider` is `google` or `gemini`.
* OPENAI_API_KEY required only when `provider` is `openai`.
* COHERE_API_KEY required for YouTube URLs, `speed: fast`, OpenAI video URL requests, and the social-media transcript fallback.

Logging

The app uses [Pino](https://github.com/pinojs/pino). In development (when `NODE_ENV` is not `production`) logs are colorized, timestamped, and indented by pino-pretty. In production they are emitted as compact newline-delimited JSON for easy piping to log aggregators. Every request-scoped log line carries a `requestId` so you can trace a single fact-check from start to finish. Large text fields are logged as previews only: transcripts, prompts, model responses, and reasoning output are truncated so logs do not contain full transcriptions or full fact-check responses.

You can override the default format with `PRETTY_LOGS=true` (force pretty) or `PRETTY_LOGS=false` (force JSON) regardless of `NODE_ENV`.

Rate limiting

Global limits — not per-IP or per-user.

| Route       | Window variable              | Max variable               | Default window | Default max |
| ----------- | ---------------------------- | -------------------------- | -------------- | ----------- |
| /api/check  | RATE_LIMIT_WINDOW_MS         | RATE_LIMIT_MAX             | 86400000 ms    | 20          |
| /api/health | HEALTH_RATE_LIMIT_WINDOW_MS  | HEALTH_RATE_LIMIT_MAX      | 500 ms         | 1           |

Direct response shape

{
  "id": "abc123def456",
  "inputMode": "url",
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "provider": "google",
  "model": "gemini-3-flash-preview",
  "models": {
    "searchPlan": "gemini-3-flash-preview",
    "finalAnswer": "gemini-3-flash-preview"
  },
  "effort": "high",
  "analysis": "Confidence: 7/10\\n\\nExplanation:\\n...",
  "reasoning": null,
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
  "transcription": {
    "text": "Transcript text...",
    "audio": {
      "apiUrl": "https://videos.bartoszbak.org/api/download",
      "filename": "audio.mp3",
      "mimeType": "audio/mpeg",
      "quality": "low",
      "sizeBytes": 9876543
    }
  },
  "webpage": null,
  "research": {
    "provider": "exa",
    "searchType": "auto",
    "queries": [
      { "query": "specific search query", "rationale": "Why this query is needed" }
    ],
    "results": [
      {
        "query": "specific search query",
        "title": "Example Source",
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
    "totalTokenCount": 2300
  },
  "warnings": []
}

Queued response shape (initial)

{ "id": "12345678", "ready": false }

Queued response shape (complete)

{
  "ready": true,
  "id": "12345678",
  "inputMode": "url",
  "url": "https://...",
  "model": "...",
  "models": { "searchPlan": "...", "finalAnswer": "..." },
  "effort": "...",
  "analysis": "...",
  "reasoning": null,
  "download": {},
  "uploadedFile": null,
  "transcription": null,
  "webpage": null,
  "research": {},
  "usage": {},
  "warnings": []
}

Setup

bun install
cp .env.example .env

Fill in GEMINI_API_KEY and EXA_API_KEY for Gemini fact-checking. Set
OPENAI_API_KEY for `provider: "openai"` requests. Set COHERE_API_KEY for
YouTube URLs, fast transcript mode, and OpenAI video URL requests.

bun run dev — listens on http://localhost:{PORT}
