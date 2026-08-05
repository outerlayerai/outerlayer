/**
 * Self-host impl of `LoggerFactory` — structured logs to stdout, no vendor.
 *
 * Never imports `@logtail/edge`. Emits one JSON line per entry (the shape a
 * self-hoster points Loki/any collector at), carrying the same `ExtendedLogContext`
 * fields the Worker logger attaches. `flush` is a no-op — stdout is synchronous.
 *
 * Vendor-free, so it lives in core alongside the interfaces it implements; the
 * Node composition root (`apps/gateway-node`, Step 5) constructs it.
 */
import type { LoggerFactory } from "../gateway-context";
import type { ExtendedLogContext, ILoggerService, LogMetadata } from "../../services/logger-types";

class StdoutLogger implements ILoggerService {
  constructor(private readonly context: ExtendedLogContext) {}

  info(message: string, metadata?: LogMetadata): void {
    this.write("info", message, metadata);
  }

  warn(message: string, metadata?: LogMetadata): void {
    this.write("warn", message, metadata);
  }

  error(error: Error, metadata?: LogMetadata): void {
    this.write("error", error.message, { ...metadata, stack: error.stack });
  }

  async flush(): Promise<void> {
    // stdout is synchronous — nothing to flush.
  }

  private write(level: string, message: string, metadata?: LogMetadata): void {
    const line = JSON.stringify({ level, message, ...this.context, ...metadata });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

export class NodeLogger implements LoggerFactory {
  createLogger(context: ExtendedLogContext = {}): ILoggerService {
    return new StdoutLogger(context);
  }
}
