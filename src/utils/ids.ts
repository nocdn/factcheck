import { factCheckJobs } from "../store";

export function createRequestId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function createJobId(): string {
  let jobId = "";

  do {
    jobId = crypto
      .getRandomValues(new Uint32Array(1))[0]!
      .toString()
      .padStart(10, "0")
      .slice(-8);
  } while (factCheckJobs.has(jobId));

  return jobId;
}
