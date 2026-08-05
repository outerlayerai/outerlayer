/**
 * verifyWorkerSecret — the per-run bearer check on the internal events/callback
 * routes. The secret lives in Vault at `worker_secret_<runId>`;
 * the Vault RPC crosses the wire, so it runs through the MSW vault handler and
 * the accept/reject branches are exercised for real.
 */

import { createClient } from "@supabase/supabase-js";
import { verifyWorkerSecret } from "../verify-worker-secret";
import { seedVaultMswState } from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";
const RUN_ID = "run-1";
const admin = () => createClient(SUPABASE_URL, ANON);

describe("verifyWorkerSecret", () => {
  it("accepts the exact stored secret presented as a Bearer token", async () => {
    seedVaultMswState({ secrets: { [`worker_secret_${RUN_ID}`]: "s3cr3t-value" } });
    expect(await verifyWorkerSecret(admin(), RUN_ID, "Bearer s3cr3t-value")).toBe(true);
  });

  it("rejects a same-length secret that does not match (constant-time compare)", async () => {
    seedVaultMswState({ secrets: { [`worker_secret_${RUN_ID}`]: "aaaaaaaaaaaa" } });
    expect(await verifyWorkerSecret(admin(), RUN_ID, "Bearer bbbbbbbbbbbb")).toBe(false);
  });

  it("rejects a different-length presented secret", async () => {
    seedVaultMswState({ secrets: { [`worker_secret_${RUN_ID}`]: "the-real-secret" } });
    expect(await verifyWorkerSecret(admin(), RUN_ID, "Bearer short")).toBe(false);
  });

  it("returns false when the auth header is missing entirely", async () => {
    seedVaultMswState({ secrets: { [`worker_secret_${RUN_ID}`]: "the-real-secret" } });
    expect(await verifyWorkerSecret(admin(), RUN_ID, null)).toBe(false);
  });

  it("returns false when the auth header is not a Bearer token", async () => {
    seedVaultMswState({ secrets: { [`worker_secret_${RUN_ID}`]: "the-real-secret" } });
    expect(await verifyWorkerSecret(admin(), RUN_ID, "Basic the-real-secret")).toBe(false);
  });

  it("fails closed on a Vault miss (secret already cleaned up)", async () => {
    // No secret seeded for this run → read_secret returns null.
    expect(await verifyWorkerSecret(admin(), RUN_ID, "Bearer anything")).toBe(false);
  });

  it("fails closed when the Vault read itself errors", async () => {
    seedVaultMswState({ forceReadError: { message: "vault unavailable" } });
    expect(await verifyWorkerSecret(admin(), RUN_ID, "Bearer anything")).toBe(false);
  });

  it("reads the secret keyed by the run id, not a shared global name", async () => {
    // A secret staged under a DIFFERENT run's name must not authorize this run.
    seedVaultMswState({ secrets: { "worker_secret_other-run": "s3cr3t-value" } });
    expect(await verifyWorkerSecret(admin(), RUN_ID, "Bearer s3cr3t-value")).toBe(false);
  });
});
