import type { FactCheckJob } from "./types";

export const factCheckJobs = new Map<string, FactCheckJob>();

// Periodic cleanup of old completed/failed jobs to prevent memory leaks.
// Runs every hour and removes jobs older than the retention window.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of factCheckJobs) {
    if (job.status !== "processing" && job.completedAt < cutoff) {
      factCheckJobs.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);
