import { createLogContext } from "./context";

describe("context", () => {
  describe("createLogContext", () => {
    it("creates context with provided tenantId, userId, and appId", () => {
      const context = createLogContext({
        tenantId: "tenant-123",
        userId: "user-456",
        appId: "app-789",
      });
      expect(context.tenantId).toBe("tenant-123");
      expect(context.userId).toBe("user-456");
      expect(context.appId).toBe("app-789");
    });

    it("creates context without optional fields when not provided", () => {
      const context = createLogContext();
      expect(context.tenantId).toBeUndefined();
      expect(context.userId).toBeUndefined();
      expect(context.appId).toBeUndefined();
    });

    it("sets isProduction based on NODE_ENV", () => {
      const originalEnv = process.env.NODE_ENV;
      const env = process.env as { NODE_ENV: string | undefined };

      env.NODE_ENV = "production";
      expect(createLogContext().isProduction).toBe(true);

      env.NODE_ENV = "development";
      expect(createLogContext().isProduction).toBe(false);

      env.NODE_ENV = originalEnv;
    });
  });
});
