import { Hono } from "hono";
import { logger } from "hono/logger";
import { mainLimiter } from "./middleware";
import { geminiApiKey, exaApiKey, port } from "./config";
import { normalizeFactCheckError } from "./utils/errors";
import health from "./routes/health";
import docs from "./routes/docs";
import jobs from "./routes/jobs";
import check from "./routes/check";

if (!geminiApiKey) {
  console.warn(
    "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set — /api/check requests will fail.",
  );
}

if (!exaApiKey) {
  console.warn(
    "EXA_API_KEY is not set — /api/check requests will fail.",
  );
}

const app = new Hono();

app.use(logger());

app.use("*", async (c, next) => {
  if (c.req.path !== "/api/check") {
    return next();
  }
  return mainLimiter(c, next);
});

app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}`, err);
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

console.log(`Listening on http://localhost:${server.port}`);

function shutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  server.stop(true);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
