import { describe, expect, it, vi, beforeEach, afterEach , type Mock } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { LoggerService, createLoggerService, createLoggerFromContext, resetLogShippingBreaker, type ExtendedLogContext } from "./logger";
import type { GatewayRequest, Env } from "@repo/gateway-core/types";
import type { ExecutionContext } from "@cloudflare/workers-types/experimental";

// Mock Logtail
const mockLogtailInstance = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
  withExecutionContext: vi.fn().mockReturnThis(),
};

vi.mock("@logtail/edge", () => ({
  Logtail: vi.fn().mockImplementation(function () {
    return mockLogtailInstance;
  }),
}));

// Mock Sentry
vi.mock("@sentry/cloudflare", () => ({
  setContext: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
}));

// Mock context module
vi.mock("@repo/gateway-core/context", () => ({
  getLogContext: vi.fn(),
}));

import { Logtail } from "@logtail/edge";
import { getLogContext } from "@repo/gateway-core/context";

describe("LoggerService", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const mockLogContext: ExtendedLogContext = {
    tenantId: "tenant-123",
    userId: "user-456",
    requestId: "req-789",
    source: "http",
  };

  const mockExecutionContext = {
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;

  const createMockEnv = (overrides: Partial<Env> = {}): Env =>
    ({
      NODE_ENV: "development",
      BETTERSTACK_LOGS_TOKEN: undefined,
      BETTERSTACK_INGESTING_URL: undefined,
      ...overrides,
    }) as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetLogShippingBreaker();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockLogtailInstance.info.mockReturnValue(Promise.resolve({}));
    mockLogtailInstance.warn.mockReturnValue(Promise.resolve({}));
    mockLogtailInstance.error.mockReturnValue(Promise.resolve({}));
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getLogContext).mockReturnValue({
      tenantId: "tenant-123",
      userId: "user-456",
      requestId: "req-789",
      isProduction: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("info", () => {
    it("logs to console in development", () => {
      const env = createMockEnv({ NODE_ENV: "development" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      logger.info("Test message");

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        "Test message",
        expect.objectContaining({
          tenantId: "tenant-123",
          userId: "user-456",
          requestId: "req-789",
        })
      );
    });

    it("logs to console with metadata", () => {
      const env = createMockEnv({ NODE_ENV: "development" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      logger.info("Test message", { endpoint: "/api/test" });

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        "Test message",
        expect.objectContaining({
          tenantId: "tenant-123",
          endpoint: "/api/test",
        })
      );
    });

    it("does not initialize Logtail in development", () => {
      const env = createMockEnv({ NODE_ENV: "development" });
      new LoggerService(env, mockLogContext, mockExecutionContext);

      expect(Logtail).not.toHaveBeenCalled();
    });

    it("initializes Logtail in production with token and endpoint", () => {
      const env = createMockEnv({
        NODE_ENV: "production",
        BETTERSTACK_LOGS_TOKEN: "test-token",
        BETTERSTACK_INGESTING_URL: "https://s123.betterstackdata.com",
      });

      new LoggerService(env, mockLogContext, mockExecutionContext);

      expect(Logtail).toHaveBeenCalledWith("test-token", {
        endpoint: "https://s123.betterstackdata.com",
        // Pinned: left on, the transport force-flushes on every context-free
        // log, turning each invocation into its own request.
        warnAboutMissingExecutionContext: false,
      });
      // The vendor's ctx binding is NOT used: it attaches the ship promise to
      // waitUntil without catching it, so a rejected ship becomes an invocation
      // failure. This service does both halves itself.
      expect(mockLogtailInstance.withExecutionContext).not.toHaveBeenCalled();
    });

    // A quota-exhausted endpoint rejects every ship. Those rejections must die
    // here: handed to waitUntil unhandled, the runtime books each one as a
    // failure of the invocation that logged it, turning one telemetry outage
    // into thousands of recorded failures on work that actually succeeded.
    it("swallows a rejected ship — the log call throws nothing and waitUntil resolves", async () => {
      const env = createMockEnv({
        NODE_ENV: "production",
        BETTERSTACK_LOGS_TOKEN: "test-token",
        BETTERSTACK_INGESTING_URL: "https://s123.betterstackdata.com",
      });
      mockLogtailInstance.info.mockReturnValueOnce(
        Promise.reject(new Error("Payment Required")),
      );

      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);
      logger.info("Test message");

      // The line was still handed to the transport — swallowing the rejection
      // must not mean skipping the attempt.
      expect(mockLogtailInstance.info).toHaveBeenCalledWith(
        "Test message",
        expect.objectContaining({ tenantId: "tenant-123" }),
      );
      // And what reaches waitUntil is settled, not the rejection.
      const handed = (mockExecutionContext.waitUntil as unknown as Mock).mock.calls.at(-1)?.[0];
      await expect(handed).resolves.toBeUndefined();
    });

    // Swallowing a failed ship stops it failing the request but does not stop
    // us ASKING. A quota-refusing endpoint refuses every line, so without a
    // breaker the gateway pays one request per line to be told no.
    it("stops building a transport after the FIRST ship failure, and recovers after the cooldown", async () => {
      const env = createMockEnv({
        NODE_ENV: "production",
        BETTERSTACK_LOGS_TOKEN: "test-token",
        BETTERSTACK_INGESTING_URL: "https://s123.betterstackdata.com",
      });
      mockLogtailInstance.info.mockReturnValue(Promise.reject(new Error("Payment Required")));

      // One refusal is enough. Breaker state is per-isolate and isolates churn,
      // so a threshold that waits for a run re-pays the cost in every fresh
      // isolate — measured as only a ~38% drop against a refusing endpoint.
      new LoggerService(env, mockLogContext, mockExecutionContext).info("m");
      await Promise.resolve();
      await Promise.resolve();
      const builtBeforeTrip = vi.mocked(Logtail).mock.calls.length;
      expect(builtBeforeTrip).toBe(1);

      // Suppressed: the next service builds no transport and ships nothing.
      mockLogtailInstance.info.mockClear();
      new LoggerService(env, mockLogContext, mockExecutionContext).info("m");
      expect(vi.mocked(Logtail).mock.calls.length).toBe(builtBeforeTrip);
      expect(mockLogtailInstance.info).not.toHaveBeenCalled();

      // Cooldown lapses → shipping resumes on its own, no redeploy needed.
      vi.setSystemTime(Date.now() + 61_000);
      mockLogtailInstance.info.mockReturnValue(Promise.resolve({}));
      new LoggerService(env, mockLogContext, mockExecutionContext).info("m");
      expect(mockLogtailInstance.info).toHaveBeenCalledWith("m", expect.objectContaining({ tenantId: "tenant-123" }));
    });

    // The transport batches lines and ships a batch with one fetch, so a shared
    // instance lets a batch opened under one invocation be awaited under the
    // next — which the Workers runtime refuses, hanging the invocation. Each
    // service must therefore construct its own.
    it("constructs a SEPARATE Logtail per service, never a shared instance", () => {
      const env = createMockEnv({
        NODE_ENV: "production",
        BETTERSTACK_LOGS_TOKEN: "test-token",
        BETTERSTACK_INGESTING_URL: "https://s123.betterstackdata.com",
      });

      new LoggerService(env, mockLogContext, mockExecutionContext);
      new LoggerService(env, mockLogContext, mockExecutionContext);

      expect(Logtail).toHaveBeenCalledTimes(2);
    });

    it("sends to Logtail in production", () => {
      const env = createMockEnv({
        NODE_ENV: "production",
        BETTERSTACK_LOGS_TOKEN: "test-token",
        BETTERSTACK_INGESTING_URL: "https://s123.betterstackdata.com",
      });

      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);
      logger.info("Test message", { action: "create" });

      expect(mockLogtailInstance.info).toHaveBeenCalledWith(
        "Test message",
        expect.objectContaining({
          tenantId: "tenant-123",
          action: "create",
        })
      );
    });

    it("does not send to Logtail in production without token", () => {
      const env = createMockEnv({
        NODE_ENV: "production",
        BETTERSTACK_LOGS_TOKEN: undefined,
      });

      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);
      logger.info("Test message");

      expect(mockLogtailInstance.info).not.toHaveBeenCalled();
    });
  });

  describe("error", () => {
    it("logs to console in development", () => {
      const env = createMockEnv({ NODE_ENV: "development" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      const error = new Error("Test error");
      logger.error(error);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Test error",
        expect.objectContaining({
          errorName: "Error",
          errorMessage: "Test error",
          tenantId: "tenant-123",
          userId: "user-456",
        })
      );
    });

    it("does not send to Sentry in development", () => {
      const env = createMockEnv({ NODE_ENV: "development" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      logger.error(new Error("Test error"));

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it("sends to Sentry in production", () => {
      const env = createMockEnv({ NODE_ENV: "production" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      const error = new Error("Test error");
      logger.error(error);

      expect(Sentry.captureException).toHaveBeenCalledWith(error);
    });

    it("sets Sentry context in production", () => {
      const env = createMockEnv({ NODE_ENV: "production" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      logger.error(new Error("Test error"));

      expect(Sentry.setContext).toHaveBeenCalledWith("logContext", {
        tenantId: "tenant-123",
        userId: "user-456",
        appId: undefined,
        requestId: "req-789",
        source: "http",
      });
    });

    it("sets Sentry user in production when userId available", () => {
      const env = createMockEnv({ NODE_ENV: "production" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      logger.error(new Error("Test error"));

      expect(Sentry.setUser).toHaveBeenCalledWith({ id: "user-456" });
    });

    it("does not set Sentry user when userId not available", () => {
      const contextWithoutUser: ExtendedLogContext = {
        ...mockLogContext,
        userId: undefined,
      };

      const env = createMockEnv({ NODE_ENV: "production" });
      const logger = new LoggerService(env, contextWithoutUser, mockExecutionContext);

      logger.error(new Error("Test error"));

      expect(Sentry.setUser).not.toHaveBeenCalled();
    });

    it("sets metadata context in Sentry when provided", () => {
      const env = createMockEnv({ NODE_ENV: "production" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      logger.error(new Error("Test error"), { source: "api-handler" });

      expect(Sentry.setContext).toHaveBeenCalledWith("metadata", {
        source: "api-handler",
      });
    });
  });

  describe("flush — telemetry must never decide whether the work succeeds", () => {
    const productionEnv = () =>
      createMockEnv({
        NODE_ENV: "production",
        BETTERSTACK_LOGS_TOKEN: "token",
        BETTERSTACK_INGESTING_URL: "https://ingest.test",
      } as Partial<Env>);

    it("resolves without waiting when the transport never settles", async () => {
      // The Logtail instance is shared across every invocation in an isolate,
      // so a flush can await transport I/O opened under an EARLIER
      // invocation's context and never settle. Unbounded, the Workers runtime
      // kills the whole invocation and the completed work is redelivered.
      vi.useFakeTimers();
      try {
        mockLogtailInstance.flush.mockReturnValueOnce(new Promise(() => {}));
        const logger = new LoggerService(productionEnv(), mockLogContext, mockExecutionContext);

        let settled = false;
        const flushed = logger.flush().then(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(1_999);
        expect(settled).toBe(false); // still inside the budget

        await vi.advanceTimersByTimeAsync(1);
        await flushed;
        expect(settled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("swallows a transport rejection instead of failing the handler", async () => {
      // Quota rejections (HTTP 402) and transport drops surface here; the
      // lines are already on stdout, which Cloudflare captures regardless.
      mockLogtailInstance.flush.mockRejectedValueOnce(new Error("Payment Required"));
      const logger = new LoggerService(productionEnv(), mockLogContext, mockExecutionContext);

      await expect(logger.flush()).resolves.toBeUndefined();
    });

    it("awaits a healthy flush rather than always paying the timeout", async () => {
      mockLogtailInstance.flush.mockResolvedValueOnce(undefined);
      const logger = new LoggerService(productionEnv(), mockLogContext, mockExecutionContext);

      await expect(logger.flush()).resolves.toBeUndefined();
      expect(mockLogtailInstance.flush).toHaveBeenCalledTimes(1);
    });

    it("is a no-op with no transport configured", async () => {
      const logger = new LoggerService(createMockEnv(), mockLogContext);
      await expect(logger.flush()).resolves.toBeUndefined();
      expect(mockLogtailInstance.flush).not.toHaveBeenCalled();
    });
  });

  describe("context injection", () => {
    it("includes context when available", () => {
      const env = createMockEnv({ NODE_ENV: "development" });
      const logger = new LoggerService(env, mockLogContext, mockExecutionContext);

      logger.info("Test message");

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        "Test message",
        expect.objectContaining({
          tenantId: "tenant-123",
          userId: "user-456",
          requestId: "req-789",
        })
      );
    });

    it("handles missing context gracefully", () => {
      const env = createMockEnv({ NODE_ENV: "development" });
      const logger = new LoggerService(env, {}, mockExecutionContext);

      logger.info("Test message");

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        "Test message",
        expect.any(Object)
      );
      // Should not have tenantId etc when context is empty
      const logPayload = consoleInfoSpy.mock.calls[0]?.[1] as Record<
        string,
        unknown
      >;
      expect(logPayload.tenantId).toBeUndefined();
    });

    it("logs Sentry context as empty when context fields are missing", () => {
      const env = createMockEnv({ NODE_ENV: "production" });
      const logger = new LoggerService(env, {}, mockExecutionContext);

      logger.error(new Error("Test error"));

      // Should call setContext with empty context fields
      expect(Sentry.setContext).toHaveBeenCalledWith("logContext", {
        tenantId: undefined,
        userId: undefined,
        appId: undefined,
        requestId: undefined,
        source: undefined,
      });
    });
  });
});

describe("createLoggerService", () => {
  const mockRequest = {
    context: {},
    user: { tenantId: "tenant-123" },
  } as unknown as GatewayRequest;

  const mockExecutionContext = {
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLogContext).mockReturnValue({
      tenantId: "tenant-123",
      userId: "user-456",
      requestId: "req-789",
      isProduction: false,
    });
  });

  it("creates logger with production config from env", () => {
    const mockEnv = {
      BETTERSTACK_LOGS_TOKEN: "token-123",
      BETTERSTACK_INGESTING_URL: "https://s123.betterstackdata.com",
      NODE_ENV: "production",
    } as unknown as Env;

    const logger = createLoggerService(mockRequest, mockEnv, mockExecutionContext);

    expect(logger).toBeInstanceOf(LoggerService);
    expect(Logtail).toHaveBeenCalledWith("token-123", {
      endpoint: "https://s123.betterstackdata.com",
      warnAboutMissingExecutionContext: false,
    });
  });

  it("creates logger with development config from env", () => {
    const mockEnv = {
      BETTERSTACK_LOGS_TOKEN: "token-123",
      BETTERSTACK_INGESTING_URL: "https://s123.betterstackdata.com",
      NODE_ENV: "development",
    } as unknown as Env;

    vi.mocked(Logtail).mockClear();
    createLoggerService(mockRequest, mockEnv, mockExecutionContext);

    expect(Logtail).not.toHaveBeenCalled();
  });
});

describe("createLoggerFromContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates logger from extended context for queue handlers", () => {
    const mockEnv = {
      BETTERSTACK_LOGS_TOKEN: "token-123",
      BETTERSTACK_INGESTING_URL: "https://s123.betterstackdata.com",
      NODE_ENV: "production",
    } as unknown as Env;

    const queueContext: ExtendedLogContext = {
      tenantId: "queue-tenant",
      appId: "queue-app",
      requestId: "queue-req",
      source: "test-queue",
    };

    const logger = createLoggerFromContext(mockEnv, queueContext);

    expect(logger).toBeInstanceOf(LoggerService);
  });
});
