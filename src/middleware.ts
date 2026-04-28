import { rateLimiter } from "hono-rate-limiter";
import { healthLimit, healthWindowMs, mainLimit, mainWindowMs } from "./config";

export const mainLimiter = rateLimiter({
  windowMs: mainWindowMs,
  limit: mainLimit,
  keyGenerator: () => "global",
  standardHeaders: true,
});

export const healthLimiter = rateLimiter({
  windowMs: healthWindowMs,
  limit: healthLimit,
  keyGenerator: () => "global",
  standardHeaders: true,
});
