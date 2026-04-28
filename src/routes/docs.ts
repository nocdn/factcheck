import { Hono } from "hono";
import { port } from "../config";

const docs = new Hono();

docs.get("/", (c) => {
  const file = Bun.file("README.md");
  return file
    .text()
    .then((body) => {
      const resolved = body.replace(/\{PORT\}/g, String(port));
      return c.text(resolved, 200, {
        "content-type": "text/plain; charset=utf-8",
      });
    })
    .catch(() => {
      return c.text("README not found.", 500, {
        "content-type": "text/plain; charset=utf-8",
      });
    });
});

export default docs;
