import pino from "pino";
import pinoPretty from "pino-pretty";
import { Writable } from "node:stream";

function shouldUsePretty(): boolean {
  const prettyEnv = process.env.PRETTY_LOGS?.trim().toLowerCase();
  if (prettyEnv === "true") return true;
  if (prettyEnv === "false") return false;
  return process.env.NODE_ENV !== "production";
}

const usePretty = shouldUsePretty();
const logLevel = process.env.LOG_LEVEL || (usePretty ? "debug" : "info");

function createJsonStripStream(): Writable {
  let buffer = "";

  return new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          process.stdout.write("\n");
          continue;
        }
        try {
          const obj = JSON.parse(line);
          delete obj.level;
          delete obj.pid;
          delete obj.hostname;
          process.stdout.write(JSON.stringify(obj) + "\n");
        } catch {
          process.stdout.write(line + "\n");
        }
      }
      callback();
    },
    final(callback) {
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer);
          delete obj.level;
          delete obj.pid;
          delete obj.hostname;
          process.stdout.write(JSON.stringify(obj) + "\n");
        } catch {
          process.stdout.write(buffer);
        }
      }
      callback();
    },
  });
}

const prettyOptions: pino.LoggerOptions = {
  level: logLevel,
  base: null,
};

const jsonOptions: pino.LoggerOptions = {
  level: logLevel,
  base: null,
};

export const logger = usePretty
  ? pino(
      prettyOptions,
      pinoPretty({
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      }),
    )
  : pino(jsonOptions, createJsonStripStream());
