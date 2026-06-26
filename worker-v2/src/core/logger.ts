/**
 * Structured logger. Emits one JSON line per event (greppable, queryable) with
 * optional bound context (stage, ark, docJobId…). `child()` returns a logger that
 * carries extra bindings — the base stage gives each stage a child bound to its name.
 */
import type { Logger } from "./types.js";

type Level = "info" | "warn" | "error";

class JsonLogger implements Logger {
  constructor(
    private readonly bindings: Record<string, unknown> = {},
    private readonly sink: (line: string) => void = (l) => process.stdout.write(l + "\n"),
  ) {}

  private emit(level: Level, event: string, data?: Record<string, unknown>): void {
    const line = JSON.stringify({ level, event, ...this.bindings, ...data });
    this.sink(line);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.emit("info", event, data);
  }
  warn(event: string, data?: Record<string, unknown>): void {
    this.emit("warn", event, data);
  }
  error(event: string, data?: Record<string, unknown>): void {
    this.emit("error", event, data);
  }
  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger({ ...this.bindings, ...bindings }, this.sink);
  }
}

export function createLogger(
  bindings: Record<string, unknown> = {},
  sink?: (line: string) => void,
): Logger {
  return new JsonLogger(bindings, sink);
}

/** Captures lines in an array — for unit tests. */
export function createMemoryLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger({}, (l) => lines.push(JSON.parse(l)));
  return { logger, lines };
}
