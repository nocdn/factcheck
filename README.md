FACTCHECK
=========

Video, transcript, and article fact-checking API powered by Gemini
and Exa search evidence.

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

Social-media videos (TikTok, Instagram, X, etc.) are sent to Gemini as inline
video data. If that fails, the request is retried once more with the same
inline-video approach. If it fails again, a final fallback attempts
transcription-based fact-checking (audio download + Cohere transcript, exactly
like YouTube URLs). This requires `COHERE_API_KEY`.

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
  -F 'searchType=deep' \
  -F 'effort=high' \
  -F 'mode=direct' \
  -F 'url=https://www.tiktok.com/@user/video/123'

Queue polling

curl http://localhost:{PORT}/api/check/12345678

Request fields

| Field             | Type    | Default | Description                                          |
| ----------------- | ------- | ------- | ---------------------------------------------------- |
| url               | string  | —       | required in JSON; optional in file mode             |
| sourceType        | string  | auto    | auto, video, webpage                                 |
| quality           | string  | 1080p   | best, 2160p, 1440p, 1080p, 720p, 480p, 360p          |
| searchType        | string  | auto    | instant, deep, reasoning (or raw Exa values)         |
| model             | string  | env     | gemini-3-flash-preview or gemini-3.1-flash-lite      |
| effort            | string  | high    | minimal, low, medium, high (alias: reasoningEffort)  |
| mode              | string  | direct  | direct (wait) or queue (return job id)               |
| additionalContext | string  | —       | optional extra instructions for the prompt          |
| iosCompatible     | boolean | true    | passed to downloader                                 |
| proxy             | boolean | false   | passed to downloader                                 |

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
| model             | model string or array used                            |
| models            | { searchPlan, finalAnswer }                           |
| reasoningEffort   | minimal, low, medium, or high                         |
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
| GEMINI_API_KEY                           | yes      | Gemini Developer API key                             | —                                          |
| EXA_API_KEY                              | yes      | Exa API key                                          | —                                          |
| COHERE_API_KEY                           | yes*     | Cohere API key for transcription (YouTube and social-media fallback) | —                                          |
| GEMINI_MODEL                             | no       | default model                                        | gemini-3-flash-preview                     |
| REASONING_EFFORT                         | no       | default reasoning effort                             | high                                       |
| EXA_SEARCH_TYPE                          | no       | default searchType                                   | auto                                       |
| PORT                                     | no       | port the API listens on                              | {PORT}                                     |
| VIDEO_DOWNLOAD_API_URL                   | no       | upstream downloader endpoint                         | https://videos.bartoszbak.org/api/download |
| FACT_CHECK_DEFAULT_QUALITY               | no       | default download quality                             | 1080p                                      |
| VIDEO_DOWNLOAD_TIMEOUT_MS                | no       | video or audio download timeout (ms)                 | 120000                                     |
| INLINE_VIDEO_MAX_BYTES                   | no       | max downloaded video size (bytes)                    | 18874368                                   |
| YOUTUBE_AUDIO_MAX_BYTES                  | no       | max YouTube audio size for Cohere (bytes)            | 26214400                                   |
| YOUTUBE_AUDIO_QUALITY                    | no       | YouTube audio quality or bitrate                     | low                                        |
| GEMINI_TIMEOUT_MS                        | no       | Gemini request timeout (ms)                          | 300000                                     |
| GEMINI_STEP_DELAY_MS                     | no       | delay before final Gemini synthesis (ms)             | 10000                                      |
| GEMINI_HIGH_DEMAND_RETRY_COUNT           | no       | retries for Gemini 503 high-demand                   | 2                                          |
| GEMINI_HIGH_DEMAND_RETRY_DELAY_MS        | no       | delay before each Gemini high-demand retry (ms)      | 10000                                      |
| FACT_CHECK_MAX_OUTPUT_TOKENS             | no       | max output tokens for fact-check                     | 32768                                      |
| FACT_CHECK_SEARCH_PLAN_MAX_OUTPUT_TOKENS | no       | max output tokens for search plan generation         | 2048                                       |
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

* COHERE_API_KEY required for YouTube URLs and for the social-media transcript fallback.

Logging

The app uses [Pino](https://github.com/pinojs/pino). In development (when `NODE_ENV` is not `production`) logs are colorized, timestamped, and indented by pino-pretty. In production they are emitted as compact newline-delimited JSON for easy piping to log aggregators. Every request-scoped log line carries a `requestId` so you can trace a single fact-check from start to finish.

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
  "model": "gemini-3-flash-preview",
  "models": {
    "searchPlan": "gemini-3-flash-preview",
    "finalAnswer": "gemini-3-flash-preview"
  },
  "reasoningEffort": "high",
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
  "reasoningEffort": "...",
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

Fill in GEMINI_API_KEY and EXA_API_KEY. Set COHERE_API_KEY for
YouTube URLs.

bun run dev — listens on http://localhost:{PORT}
