import pino from "pino";
import { Writable } from "node:stream";

export interface LogEntry {
  timestamp: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  msg: string;
  [key: string]: unknown;
}

const LEVEL_MAP: Record<number, LogEntry["level"]> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LOG_BUFFER_MAX = 500;
const logBuffer: LogEntry[] = [];

export function getLogBuffer(): readonly LogEntry[] {
  return logBuffer;
}

class LogBufferStream extends Writable {
  _write(chunk: Buffer | string, _enc: string, done: () => void): void {
    const line = chunk.toString().trim();
    if (line) {
      try {
        const { time, level: lvl, msg, pid: _pid, hostname: _h, v: _v, ...rest } = JSON.parse(line) as Record<string, unknown>;
        const entry: LogEntry = {
          timestamp:
            typeof time === "number"
              ? new Date(time).toISOString()
              : typeof time === "string"
              ? time
              : new Date().toISOString(),
          level: LEVEL_MAP[lvl as number] ?? "info",
          msg: typeof msg === "string" ? msg : "",
          ...rest,
        };
        logBuffer.push(entry);
        if (logBuffer.length > LOG_BUFFER_MAX) {
          logBuffer.shift();
        }
      } catch {
        // linha não-JSON (ex: stack trace parcial) — ignora no buffer
      }
      process.stdout.write(line + "\n");
    }
    done();
  }
}

export const logger = pino(
  { level: process.env.LOG_LEVEL || "info" },
  new LogBufferStream()
);
