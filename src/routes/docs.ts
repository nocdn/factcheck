import { Hono } from "hono";
import { port } from "../config";

const docs = new Hono();

docs.get("/", (c) => {
  const body = `FACTCHECK
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

curl -X POST http://localhost:${port}/api/check \\
  -H 'content-type: application/json' \\
  -d '{
    "url": "https://www.tiktok.com/@user/video/123",
    "searchType": "deep",
    "effort": "high",
    "mode": "direct"
  }'

curl -X POST http://localhost:${port}/api/check \\
  -H 'content-type: application/json' \\
  -d '{
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "searchType": "reasoning",
    "mode": "queue"
  }'

curl -X POST http://localhost:${port}/api/check \\
  -H 'content-type: application/json' \\
  -d '{
    "url": "https://example.com/article.html",
    "sourceType": "webpage",
    "searchType": "instant",
    "mode": "direct"
  }'

POST /api/check — file upload mode

curl -X POST http://localhost:${port}/api/check \\
  -F 'file=@/path/to/video.mp4' \\
  -F 'searchType=deep' \\
  -F 'effort=high' \\
  -F 'mode=direct' \\
  -F 'url=https://www.tiktok.com/@user/video/123'

Queue polling

curl http://localhost:${port}/api/check/12345678

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
| transcription     | Cohere transcript + audio metadata (YouTube only)     |
| webpage           | Exa article metadata (article mode only)              |
| research          | Exa queries, searchType used, and full-text results   |
| usage             | prompt, candidate, thought, and total tokens          |
| warnings          | array of informative warnings                         |

Environment

| Variable              | Required | Description                                           |
| --------------------- | -------- | ----------------------------------------------------- |
| GEMINI_API_KEY        | yes      | for /api/check                                        |
| EXA_API_KEY           | yes      | for /api/check                                        |
| COHERE_API_KEY        | yes      | for YouTube URLs                                      |
| GEMINI_MODEL          | no       | default model when request omits it                   |
| REASONING_EFFORT      | no       | default effort when request omits it                  |
| EXA_SEARCH_TYPE       | no       | default searchType when request omits it              |
| PORT                  | no       | ${port}                                               |
| RATE_LIMIT_MAX        | no       | ${20} per RATE_LIMIT_WINDOW_MS (default 24h)          |
| HEALTH_RATE_LIMIT_MAX | no       | 1 per HEALTH_RATE_LIMIT_WINDOW_MS (default 500ms)     |
`;

  return c.text(body, 200, { "content-type": "text/plain; charset=utf-8" });
});

export default docs;
