/**
 * Cloudflare/hosted impl of `LoggerFactory`.
 *
 * Produces the existing `LoggerService` (BetterStack via `@logtail/edge`, with
 * its built-in stdout fallback when the BetterStack vars are unset). This is the
 * facade that keeps `@logtail/edge` on the Worker side — `gateway-core` depends
 * only on the `LoggerFactory` interface, never on this file. Mirrors the
 * error-reporting facade (`services/error-reporting/sentry.ts`).
 *
 * Constructed once at the composition root with `env` + the request `execCtx`
 * (the `withExecutionContext` flush binding); `createLogger(context)` is the
 * per-call factory that replaces direct `createLoggerFromContext(env, …)` /
 * `new LoggerService(env, …)` construction in Step 3e.
 */
import type { Env } from "@repo/gateway-core/types";
import type { ExecutionCtx } from "@repo/gateway-core/runtime/execution";
import type { LoggerFactory } from "@repo/gateway-core/runtime/gateway-context";
import { LoggerService, type ExtendedLogContext, type ILoggerService } from "../../services/logger";

export class WorkerLogger implements LoggerFactory {
  constructor(
    private readonly env: Env,
    private readonly execCtx?: ExecutionCtx,
  ) {}

  createLogger(context: ExtendedLogContext = {}): ILoggerService {
    return new LoggerService(this.env, context, this.execCtx);
  }
}
