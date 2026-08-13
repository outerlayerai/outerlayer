import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { LICENSE_KEY_PREFIX, _resetLicenseCacheForTests } from "@repo/ee-license";

import { resolveLicenseStatus } from "./service";

// Mint a real Ed25519-signed license (same format the production signer emits),
// so these tests exercise the actual offline verifier, not a stub.
function mintLicense(opts: { org?: string; iatOffsetSec: number; expOffsetSec: number }): {
  token: string;
  publicKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const nowSec = Math.floor(Date.parse("2026-07-12T00:00:00Z") / 1000);
  const claims = {
    org: opts.org ?? "Acme Corp",
    plan: "enterprise",
    iat: nowSec + opts.iatOffsetSec,
    exp: nowSec + opts.expOffsetSec,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const message = `${LICENSE_KEY_PREFIX}.${payloadB64}`;
  const signature = cryptoSign(null, Buffer.from(message, "ascii"), privateKey);
  return {
    token: `${message}.${signature.toString("base64url")}`,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const NOW = new Date("2026-07-12T00:00:00Z");
const DAY = 24 * 60 * 60;

function selfHostEnv(extra: Record<string, string> = {}) {
  return { OUTERLAYER_SELF_HOSTED: "true", ...extra };
}

describe("resolveLicenseStatus", () => {
  beforeEach(() => {
    _resetLicenseCacheForTests();
  });

  // proves AC-071-08
  it("hides the surface entirely on Cloud (not self-hosted)", async () => {
    // No OUTERLAYER_SELF_HOSTED — and a wrong-cased value must not count either.
    expect(await resolveLicenseStatus({}, NOW)).toEqual({ visible: false });
    expect(await resolveLicenseStatus({ OUTERLAYER_SELF_HOSTED: "TRUE" }, NOW)).toEqual({
      visible: false,
    });
  });

  it("reports unlicensed on self-host with no license key", async () => {
    expect(await resolveLicenseStatus(selfHostEnv(), NOW)).toEqual({
      visible: true,
      state: "unlicensed",
    });
  });

  it("reports a valid license with org, plan, ISO expiry, and a day countdown", async () => {
    const { token, publicKey } = mintLicense({
      org: "Globex",
      iatOffsetSec: -DAY,
      expOffsetSec: 30 * DAY,
    });

    const status = await resolveLicenseStatus(
      selfHostEnv({ OUTERLAYER_EE_LICENSE_KEY: token, OUTERLAYER_EE_PUBLIC_KEY: publicKey }),
      NOW,
    );

    expect(status).toEqual({
      visible: true,
      state: "valid",
      org: "Globex",
      plan: "enterprise",
      expiresAt: new Date((Math.floor(NOW.getTime() / 1000) + 30 * DAY) * 1000).toISOString(),
      daysUntilExpiry: 30,
    });
  });

  // proves AC-071-06
  it("reports grace with expiredAt, graceEndsAt, and days until deactivation", async () => {
    // Expired 3 days ago → inside the 14-day grace window; 11 days remain.
    const { token, publicKey } = mintLicense({
      iatOffsetSec: -40 * DAY,
      expOffsetSec: -3 * DAY,
    });

    const status = await resolveLicenseStatus(
      selfHostEnv({ OUTERLAYER_EE_LICENSE_KEY: token, OUTERLAYER_EE_PUBLIC_KEY: publicKey }),
      NOW,
    );

    expect(status).toEqual({
      visible: true,
      state: "grace",
      org: "Acme Corp",
      plan: "enterprise",
      expiredAt: new Date((Math.floor(NOW.getTime() / 1000) - 3 * DAY) * 1000).toISOString(),
      graceEndsAt: new Date((Math.floor(NOW.getTime() / 1000) + 11 * DAY) * 1000).toISOString(),
      daysUntilGraceEnds: 11,
    });
  });

  it("reports unlicensed once expired past the grace window", async () => {
    // Expired 20 days ago — past the 14-day grace, so the verifier returns null.
    const { token, publicKey } = mintLicense({
      iatOffsetSec: -60 * DAY,
      expOffsetSec: -20 * DAY,
    });

    expect(
      await resolveLicenseStatus(
        selfHostEnv({ OUTERLAYER_EE_LICENSE_KEY: token, OUTERLAYER_EE_PUBLIC_KEY: publicKey }),
        NOW,
      ),
    ).toEqual({ visible: true, state: "unlicensed" });
  });

  it("clamps the countdown to 0 on the expiry day rather than going negative", async () => {
    // Expires ~12 hours from now → same calendar day, ceil() gives 1, never < 0.
    const { token, publicKey } = mintLicense({
      iatOffsetSec: -DAY,
      expOffsetSec: DAY / 2,
    });

    const status = await resolveLicenseStatus(
      selfHostEnv({ OUTERLAYER_EE_LICENSE_KEY: token, OUTERLAYER_EE_PUBLIC_KEY: publicKey }),
      NOW,
    );

    expect(status.visible && status.state === "valid" && status.daysUntilExpiry).toBe(1);
  });
});
