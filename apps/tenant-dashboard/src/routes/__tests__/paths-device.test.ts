/**
 * Tests for the CLI device-login path builders: the org-less entry point
 * (`paths.device.root`, what the /start route's verification_url points at)
 * and the org-scoped approval page (`paths.orgs.org.device`).
 */

import { describe, it, expect } from "vitest";

import { paths } from "../paths";

describe("device-login path builders", () => {
  it("device.root is the org-less entry point", () => {
    expect(paths.device.root).toBe("/device");
  });

  it("orgs.org.device resolves under the org", () => {
    expect(paths.orgs.org.device.root("acme")).toBe("/orgs/acme/device");
  });
});
