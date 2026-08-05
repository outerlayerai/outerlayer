/**
 * `mintEvalWorkerCredentials` — the per-run worker key.
 *
 * Boundary: `@repo/api-key-service` is a true seam (mocked — its own package
 * tests own mint semantics). The service-role client is constructed inside the
 * function; here we pin the mint options (a drift changes what the key can do)
 * and assert the plaintext is returned exactly once and persisted NOWHERE
 * server-side (the Vault MSW state pins that negative).
 */

import { getVaultMswState } from "@/test-helpers/msw-handlers";

vi.mock("@/config-global.server", () => ({
  API_KEY_PEPPER: "test-pepper",
  SUPABASE_SECRET_KEY: "test-service-role-key",
}));

const { mockMintApiKey } = vi.hoisted(() => ({ mockMintApiKey: vi.fn() }));
vi.mock("@repo/api-key-service", () => ({ mintApiKey: mockMintApiKey }));

import { evalRunKeyName, mintEvalWorkerCredentials } from "./eval-worker-credentials";

const RUN_ID = "d4f7a2b1-9c3e-4f5a-8b6d-1e2f3a4b5c6d";

const INPUT = {
  tenantId: "tenant-1",
  appId: "app-1",
  environmentId: "env-1",
  runId: RUN_ID,
};

beforeEach(() => {
  mockMintApiKey.mockReset();
  mockMintApiKey.mockResolvedValue({
    plaintext: "sk_outerlayer_eval_PLAINTEXT",
    row: { id: "row-9", api_key_id: "ak_9" },
  });
});

describe("evalRunKeyName", () => {
  it("is the exact name the gateway's run<->key binding checks", () => {
    expect(evalRunKeyName(RUN_ID)).toBe(`eval-run:${RUN_ID}`);
  });
});

describe("mintEvalWorkerCredentials", () => {
  it("mints a short-lived machine key with exactly the ingest permissions and returns the plaintext once", async () => {
    const before = Date.now();
    const out = await mintEvalWorkerCredentials(INPUT);
    const after = Date.now();

    expect(out).toEqual({ key: "sk_outerlayer_eval_PLAINTEXT" });

    // Pinned option literal: any drift here changes what the key can do.
    expect(mockMintApiKey).toHaveBeenCalledTimes(1);
    const args = mockMintApiKey.mock.calls[0]![0];
    // The row client and admin client are the same service-role instance the
    // function constructs — the mint writes the key-store under RLS bypass.
    expect(args.rowClient).toBe(args.adminClient);
    expect(args).toMatchObject({
      pepper: "test-pepper",
      tenantId: "tenant-1",
      appId: "app-1",
      name: `eval-run:${RUN_ID}`,
      environmentId: "env-1",
      permissions: ["score.write", "trace.write"],
      isMachine: true,
      actorMembershipId: null,
      createdBy: null,
      replaceExisting: true,
      prefix: "sk_outerlayer_eval_",
    });

    // 24h expiry window — the backstop for a worker that dies before the
    // gateway's terminal-status auto-revoke fires.
    const expiresAt = new Date(args.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 25 * 60 * 60 * 1000);
  });

  it("persists the plaintext NOWHERE server-side (Machine env is the only carrier)", async () => {
    await mintEvalWorkerCredentials(INPUT);
    // No Vault write — the plaintext is never persisted server-side.
    expect(getVaultMswState().secrets).toEqual({});
  });

  it("propagates a mint failure so the dispatcher fails the run", async () => {
    mockMintApiKey.mockRejectedValueOnce(new Error("duplicate key value"));
    await expect(mintEvalWorkerCredentials(INPUT)).rejects.toThrow("duplicate key value");
    expect(getVaultMswState().secrets).toEqual({});
  });
});
