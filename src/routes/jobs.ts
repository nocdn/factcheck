import { Hono } from "hono";
import { factCheckJobs } from "../store";

const jobs = new Hono();

jobs.get("/:jobId", (c) => {
  const jobId = c.req.param("jobId");
  const job = factCheckJobs.get(jobId);

  if (!job) {
    return c.json({ error: "Job not found." }, 404);
  }

  if (job.status === "processing") {
    return c.json({ id: jobId, ready: false });
  }

  if (job.status === "failed") {
    return c.json(
      {
        id: jobId,
        ready: true,
        error: job.error,
      },
      job.statusCode,
    );
  }

  return c.json({
    ready: true,
    ...job.result,
  });
});

export default jobs;
