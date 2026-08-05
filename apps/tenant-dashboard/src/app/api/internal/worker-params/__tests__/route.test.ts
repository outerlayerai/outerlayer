// @vitest-environment node
/**
 * Tests: GET /api/internal/worker-params
 *
 * The single-use token endpoint an ephemeral worker machine hits at boot to
 * fetch its full params payload — INCLUDING SECRETS (git token, agent
 * credential, per-run secret) — instead of receiving them in plaintext Fly
 * config. The security contract:
 *
 *   1. worker_run_id required and UUID-shaped (400), Bearer token required (401)
 *   2. the token lives in Vault; a missing entry (already consumed) → 401
 *   3. a malformed Vault entry → 500 (fail closed, not a crash)
 *   4. a constant-time (`safeCompare`) token check; mismatch → 401, and a wrong
 *      guess must NOT consume the entry
 *   5. SINGLE-USE: on success the Vault entry is deleted BEFORE the payload is
 *      returned, so the token can't be replayed. This is the property that
 *      matters most.
 *
 * Vault RPCs are an HTTP boundary → MSW (`seedVaultMswState` /
 * `getVaultMswState`); `delete_secret` actually removes the entry, so "the
 * entry is gone" is a faithful proxy for "the token was consumed".
 * serverLogger is an internal seam → mocked.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn() },
}));

beforeAll(() => {
  // NextResponse.json delegates to the static Response.json, absent in the
  // node test runtime — polyfill it so the route can build responses.
  if (typeof (globalThis.Response as unknown as { json?: unknown }).json !== "function") {
    (globalThis.Response as unknown as { json: unknown }).json = (
      body: unknown,
      init?: ResponseInit,
    ) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      });
  }
});

import { GET } from "../route";
import { seedVaultMswState, getVaultMswState } from "@/test-helpers/msw-handlers";
import { workerTokenVaultName } from "@repo/worker-core";

const RUN_ID = "3f2a9c1e-5b47-4d8a-9e10-6c2b7f0a4d31";
const VAULT_NAME = workerTokenVaultName(RUN_ID);
const TOKEN = "worker-boot-token-value";

/** Seed the Vault entry the worker machine was provisioned with. */
function seedToken(token: string, payload: Record<string, unknown>) {
  seedVaultMswState({ secrets: { [VAULT_NAME]: JSON.stringify({ token, payload }) } });
}

/** Build the GET. `runId: null` omits the query param; `token: null` omits the header. */
function get(opts: { runId?: string | null; token?: string | null } = {}): NextRequest {
  const url = new URL("http://localhost/api/internal/worker-params");
  if (opts.runId !== null) {
    url.searchParams.set("worker_run_id", opts.runId ?? RUN_ID);
  }
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return new NextRequest(url, { headers });
}

describe("GET /api/internal/worker-params", () => {
  it("400s when worker_run_id is missing", async () => {
    const res = await GET(get({ runId: null }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Missing worker_run_id parameter");
  });

  // The run id is concatenated into the Vault secret name, so a non-UUID must
  // be refused before it can reach the lookup — including values that would
  // escape the `worker_token_<uuid>` namespace outright.
  it.each([
    "worker-run-params-1",
    "../build_token_abc",
    "3f2a9c1e-5b47-4d8a-9e10-6c2b7f0a4d31 extra",
    "3f2a9c1e5b474d8a9e106c2b7f0a4d31",
    "",
  ])("400s when worker_run_id is not a UUID (%j)", async runId => {
    const res = await GET(get({ runId }));

    expect(res.status).toBe(400);
    // An empty value is caught by the missing-param branch, not the shape one.
    expect((await res.json()).error).toBe(
      runId === "" ? "Missing worker_run_id parameter" : "Invalid worker_run_id parameter",
    );
  });

  it("401s when the Authorization header is missing or not Bearer", async () => {
    const res = await GET(get({ token: null }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("401s when the Vault entry is absent (token already consumed / replay)", async () => {
    // Nothing seeded → read_secret returns null.
    const res = await GET(get());

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("500s when the Vault entry is not valid JSON", async () => {
    seedVaultMswState({ secrets: { [VAULT_NAME]: "not-json{" } });

    const res = await GET(get());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Internal error");
  });

  it("401s on token mismatch and does NOT consume the single-use entry", async () => {
    seedToken(TOKEN, { repo_token: "ghs_x" });

    const res = await GET(get({ token: "wrong-token-same-shape!!" }));

    expect(res.status).toBe(401);
    // A wrong guess must not burn the legit token — the entry is byte-for-byte
    // unchanged, not merely present.
    expect(getVaultMswState().secrets[VAULT_NAME]).toBe(
      JSON.stringify({ token: TOKEN, payload: { repo_token: "ghs_x" } }),
    );
  });

  it("returns the payload AND consumes the token on success (single-use, replay-proof)", async () => {
    const payload = { worker_run_id: RUN_ID, repo_token: "ghs_secret", worker_secret: "s3cr3t" };
    seedToken(TOKEN, payload);

    const res = await GET(get());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    // The single-use property: a successful fetch deletes the Vault entry, so a
    // replay of the same token would now 401. Drop the delete_secret call and
    // the entry survives → this fails.
    expect(getVaultMswState().secrets[VAULT_NAME]).toBeUndefined();
  });
});
