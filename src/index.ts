import { Hono } from "hono";
import { mainLimiter } from "./middleware";
import { geminiApiKey, exaApiKey, port } from "./config";
import { normalizeFactCheckError } from "./utils/errors";
import { logger } from "./utils/logger";
import health from "./routes/health";
import docs from "./routes/docs";
import jobs from "./routes/jobs";
import check from "./routes/check";

if (!geminiApiKey) {
  logger.warn(
    "GEMINI_API_KEY is not set — Gemini /api/check requests will fail.",
  );
}

if (!exaApiKey) {
  logger.warn(
    "EXA_API_KEY is not set — /api/check requests will fail.",
  );
}

const app = new Hono();

app.use(async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: ms,
    },
    `${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`,
  );
});

app.use("*", async (c, next) => {
  if (c.req.path !== "/api/check") {
    return next();
  }
  return mainLimiter(c, next);
});

app.onError((err, c) => {
  logger.error(
    {
      method: c.req.method,
      path: c.req.path,
      error: err instanceof Error ? err.message : String(err),
    },
    `${c.req.method} ${c.req.path} error`,
  );
  const normalized = normalizeFactCheckError(err);
  return c.json({ error: normalized.error }, normalized.status as any);
});

app.route("/api/health", health);
app.route("/", docs);
app.route("/api/check", check);
app.route("/api/check", jobs);

const server = Bun.serve({
  fetch: app.fetch,
  port,
});

logger.info(`Listening on http://localhost:${server.port}`);

function shutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  server.stop(true);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
