import { Hono } from "hono";
import {
  cohereApiKey,
  defaultGeminiSettings,
  defaultOpenAiSettings,
  exaApiKey,
  geminiApiKey,
  openAiApiKey,
} from "../config";
import { healthLimiter } from "../middleware";

const health = new Hono();

health.use(healthLimiter);

health.get("/", (c) => {
  return c.json({
    status: "ok",
    geminiConfigured: Boolean(geminiApiKey),
    openAiConfigured: Boolean(openAiApiKey),
    exaConfigured: Boolean(exaApiKey),
    cohereConfigured: Boolean(cohereApiKey),
    model: defaultGeminiSettings.models.searchPlan,
    models: defaultGeminiSettings.models,
    providers: {
      google: {
        configured: Boolean(geminiApiKey),
        models: defaultGeminiSettings.models,
        effort: defaultGeminiSettings.effort,
      },
      openai: {
        configured: Boolean(openAiApiKey),
        models: defaultOpenAiSettings.models,
        effort: defaultOpenAiSettings.effort,
      },
    },
    effort: defaultGeminiSettings.effort,
  });
});

export default health;
