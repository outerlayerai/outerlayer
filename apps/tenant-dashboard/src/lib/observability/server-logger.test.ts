import * as Sentry from "@/lib/observability/error-reporting/sentry";
import type { MockInstance } from "vitest";

// Mock Logger class from @logtail/next
const mockLogtailInfo = vi.fn();
const mockLogtailFlush = vi.fn().mockResolvedValue(undefined);

vi.mock("@logtail/next", () => ({
  Logger: vi.fn().mockImplementation(function () {
    return {
      info: mockLogtailInfo,
      flush: mockLogtailFlush,
    };
  }),
}));

// Mock getLogContext
const mockGetLogContext = vi.fn();
vi.mock("../../utils/context", () => ({
  getLogContext: (...args: unknown[]) => mockGetLogContext(...args),
}));

// Mock Sentry
vi.mock("@/lib/observability/error-reporting/sentry", () => ({
  setContext: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
}));

// Mock OpenTelemetry trace
vi.mock("@opentelemetry/api", () => ({
  trace: {
    getActiveSpan: vi.fn().mockReturnValue(null),
  },
}));

import { serverLogger } from "./server-logger";

// Helper to set NODE_ENV for tests
function setNodeEnv(value: string) {
  (process.env as { NODE_ENV: string }).NODE_ENV = value;
}

describe("ServerLogger", () => {
  let consoleInfoSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetLogContext.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    setNodeEnv(originalEnv || "test");
  });

  describe("info", () => {
    it("logs to console in development", async () => {
      setNodeEnv("development");

      await serverLogger.info("Test message");

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        "[INFO]",
        "Test message",
        expect.objectContaining({
          message: "Test message",
        })
      );
    });

    it("logs to console with metadata", async () => {
      setNodeEnv("development");

      await serverLogger.info("Test message", { component: "DataGrid" });

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        "[INFO]",
        "Test message",
        expect.objectContaining({
          message: "Test message",
          component: "DataGrid",
        })
      );
    });

    it("does not send to Logtail in development", async () => {
      setNodeEnv("development");

      await serverLogger.info("Test message");

      expect(mockLogtailInfo).not.toHaveBeenCalled();
    });

    it("sends to Logtail in production", async () => {
      setNodeEnv("production");

      await serverLogger.info("Test message", { action: "create" });

      expect(mockLogtailInfo).toHaveBeenCalledWith(
        "Test message",
        expect.objectContaining({
          message: "Test message",
          action: "create",
        })
      );
      expect(mockLogtailFlush).toHaveBeenCalledWith();
    });

    it("auto-injects context from getLogContext", async () => {
      setNodeEnv("production");
      mockGetLogContext.mockResolvedValue({
        tenantId: "tenant-123",
        userId: "user-456",
        appId: "app-789",
        isProduction: true,
      });

      await serverLogger.info("Test message");

      expect(mockLogtailInfo).toHaveBeenCalledWith(
        "Test message",
        expect.objectContaining({
          tenantId: "tenant-123",
          userId: "user-456",
          appId: "app-789",
        })
      );
    });

    it("passes appId to getLogContext when using withAppId", async () => {
      setNodeEnv("production");
      mockGetLogContext.mockResolvedValue({
        tenantId: "tenant-123",
        userId: "user-456",
        appId: "custom-app-id",
        isProduction: true,
      });

      await serverLogger.withAppId("custom-app-id").info("Test message");

      expect(mockGetLogContext).toHaveBeenCalledWith("custom-app-id");
    });
  });

  describe("error", () => {
    it("logs to console in development", async () => {
      setNodeEnv("development");

      const error = new Error("Test error");
      await serverLogger.error(error);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[ERROR]",
        "Test error",
        expect.objectContaining({
          message: "Test error",
        })
      );
    });

    it("does not send to Sentry in development", async () => {
      setNodeEnv("development");

      await serverLogger.error(new Error("Test error"));

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it("sends to Sentry in production", async () => {
      setNodeEnv("production");

      const error = new Error("Test error");
      await serverLogger.error(error);

      expect(Sentry.captureException).toHaveBeenCalledWith(error);
    });

    it("sets Sentry context from auto-injected context", async () => {
      setNodeEnv("production");
      mockGetLogContext.mockResolvedValue({
        tenantId: "tenant-123",
        userId: "user-456",
        appId: "app-789",
        isProduction: true,
      });

      await serverLogger.error(new Error("Test error"));

      expect(Sentry.setContext).toHaveBeenCalledWith("logContext", {
        tenantId: "tenant-123",
        userId: "user-456",
        appId: "app-789",
      });
      expect(Sentry.setUser).toHaveBeenCalledWith({ id: "user-456" });
    });

    it("sets Sentry metadata context when provided", async () => {
      setNodeEnv("production");

      await serverLogger.error(new Error("Test error"), { action: "delete" });

      expect(Sentry.setContext).toHaveBeenCalledWith("metadata", {
        action: "delete",
      });
    });

    it("does not set Sentry context when no context available", async () => {
      setNodeEnv("production");
      mockGetLogContext.mockResolvedValue(undefined);

      await serverLogger.error(new Error("Test error"));

      expect(Sentry.setContext).not.toHaveBeenCalledWith(
        "logContext",
        expect.anything()
      );
      expect(Sentry.setUser).not.toHaveBeenCalled();
    });
  });
});
