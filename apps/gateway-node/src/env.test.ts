/**
 * Tests: the self-host boot gate's API-key auth posture.
 *
 * The bug class: a gateway that boots happily with no verified API-key auth. The
 * gate's job is to make the operator state a posture, so "I didn't know" is not
 * a reachable outcome. `loadEnv` exits the process on failure rather than
 * throwing, so these assert on the exit and on what the operator is told.
 *
 * The S3/Supabase/ClickHouse requirements are set up as a passing baseline here
 * so a failure is unambiguously about the auth posture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadEnv } from "./env";

/** Every non-auth requirement the gate enforces, satisfied. */
const BASELINE = {
  SUPABASE_API_BASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  SUPABASE_JWT_SECRET: "jwt-secret-value-for-tests-0000000",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  CLICKHOUSE_HOST: "http://localhost:8123",
  CLICKHOUSE_PASSWORD: "clickhouse-password",
  BLOB_STORAGE_BACKEND: "s3",
  BLOB_S3_ENDPOINT: "http://127.0.0.1:9300",
  BLOB_S3_ACCESS_KEY_ID: "minioadmin",
  BLOB_S3_SECRET_ACCESS_KEY: "minioadmin",
  BLOB_S3_BUCKET: "trace-blobs",
};

const VALID_SECRET = "k4Jd8vQ2mN7pR1sT5wY9zB3cF6hL0xA8"; // 32 chars

let exitSpy: ReturnType<typeof vi.spyOn>;
let stderr: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = process.env;
  process.env = { ...BASELINE } as NodeJS.ProcessEnv;
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    stderr += String(chunk);
    return true;
  });
  // Swallow the exit so the assertions below can run; the spy records the call.
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
});

describe("loadEnv — API-key auth posture", () => {
  it("refuses to boot when neither the secret nor perimeter trust is declared", () => {
    loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr).toContain("SELF_HOST_GATEWAY_SECRET");
    // The operator has to be told both options, not just that something is wrong.
    expect(stderr).toContain("SELF_HOST_TRUST_PERIMETER=true");
    // …and what the current state actually means.
    expect(stderr).toContain("FULL ACCESS");
  });

  it("boots quietly with a secret of sufficient length", () => {
    process.env.SELF_HOST_GATEWAY_SECRET = VALID_SECRET;

    loadEnv();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr).toBe("");
  });

  // A short secret is worse than none: it reads as protection while being
  // online-guessable against a reachable service.
  it.each(["short", "k4Jd8vQ2mN7pR1sT5wY9zB3cF6hL0xA"]) // 5 and 31 chars
    ("refuses to boot on a %j-length secret", secret => {
      process.env.SELF_HOST_GATEWAY_SECRET = secret;

      loadEnv();

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderr).toContain("at least 32");
    });

  it("boots on declared perimeter trust, but warns on every boot", () => {
    process.env.SELF_HOST_TRUST_PERIMETER = "true";

    loadEnv();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr).toContain("WARNING");
    expect(stderr).toContain("perimeter-trust");
    expect(stderr).toContain("full access to that tenant");
  });

  it("does not warn when a secret is verifying requests", () => {
    process.env.SELF_HOST_GATEWAY_SECRET = VALID_SECRET;
    process.env.SELF_HOST_TRUST_PERIMETER = "true";

    loadEnv();

    expect(exitSpy).not.toHaveBeenCalled();
    // The secret takes precedence — there is no perimeter trust to warn about.
    expect(stderr).toBe("");
  });

  // Only the exact string 'true' opts in. A typo must fail closed rather than
  // be read as "yes" by a loose truthiness check.
  it.each(["1", "yes", "TRUE", "false", ""])(
    "treats SELF_HOST_TRUST_PERIMETER=%j as not declared",
    value => {
      process.env.SELF_HOST_TRUST_PERIMETER = value;

      loadEnv();

      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it("ignores a whitespace-only secret rather than accepting it", () => {
    process.env.SELF_HOST_GATEWAY_SECRET = "                                   ";

    loadEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr).toContain("SELF_HOST_TRUST_PERIMETER=true");
  });
});
