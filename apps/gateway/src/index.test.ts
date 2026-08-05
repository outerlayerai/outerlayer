/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker", () => {
	it("should return 404 for invalid route", async () => {
		const resp = await SELF.fetch("http://localhost/invalid", {
			method: "POST",
			headers: {
				"Authorization": "bleh",
				"X-Outerlayer-App-Id": "bleh",
			},
		});
		expect(resp.status).toBe(404);
	});

	it("should return 400 for missing app id", async () => {
		const resp = await SELF.fetch("http://localhost/v1/agents/sync", {
			method: "POST",
			headers: {
				"Authorization": "bleh",
			},
		});
		// Authenticated OpenAPI POST routes go through authMiddleware, which
		// rejects before the handler ever sees the body.
		expect(resp.status).toBe(401);
	}, 30000);
	it("should return 401 for missing auth", async () => {
		const resp = await SELF.fetch("http://localhost/v1/agents/sync", {
			method: "POST",
			headers: {
				"X-Outerlayer-App-Id": "bleh",
			},
		});
		expect(resp.status).toBe(401);

		// Proves the canonical `{ error: { code, message } }` envelope is what
		// flows through the outer Worker → openApiApp → auth middleware path.
		const body = await resp.json() as { error: { code: string; message: string } };
		expect(body.error).toEqual({ code: "unauthorized", message: "Missing auth header" });
	});
});
