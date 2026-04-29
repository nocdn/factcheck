import { Hono } from "hono";
import {
  cohereApiKey,
  defaultGeminiSettings,
  exaApiKey,
  geminiApiKey,
} from "../config";
import { healthLimiter } from "../middleware";

const health = new Hono();

health.use(healthLimiter);

health.get("/", (c) => {
  return c.json({
    status: "ok",
    geminiConfigured: Boolean(geminiApiKey),
    exaConfigured: Boolean(exaApiKey),
    cohereConfigured: Boolean(cohereApiKey),
    model: defaultGeminiSettings.models.searchPlan,
    models: defaultGeminiSettings.models,
    reasoningEffort: defaultGeminiSettings.reasoningEffort,
  });
});

export default health;
