/**
 * Tests for the env-aware `appPaths` route builders.
 *
 * After the env-routing migration every app tab lives under an
 * `/orgs/<org>/apps/<app>/env/<env>/<tab>` segment, so each builder takes
 * `envName` after `appName`. These tests pin the exact emitted URL for every
 * builder — a dropped/misplaced `/env/<env>/` segment, a wrong tab suffix, or
 * a broken join would change a concrete string here.
 *
 * The one documented exception is `appPaths.context` — an app-level lifecycle
 * surface with NO env segment.
 */

import { describe, it, expect } from "vitest";

import { appPaths } from "../paths";

const ORG = "acme";
const APP = "support-bot";
const ENV = "prod";
const BASE = `/orgs/${ORG}/apps/${APP}/env/${ENV}`;

describe("appPaths — env-scoped builders", () => {
  it("agents (sessions list + session detail by traceId + findings)", () => {
    expect(appPaths.agents.sessions(ORG, APP, ENV)).toBe(`${BASE}/agents/sessions`);
    // the detail builder interpolates the traceId as the last segment
    expect(appPaths.agents.session(ORG, APP, ENV, "1b247b75d348")).toBe(
      `${BASE}/agents/sessions/1b247b75d348`,
    );
    expect(appPaths.agents.findings(ORG, APP, ENV)).toBe(`${BASE}/agents/findings`);
  });

  it("settings (developers) index + every sub-page", () => {
    expect(appPaths.developers.root(ORG, APP, ENV)).toBe(`${BASE}/settings`);
    expect(appPaths.developers.general(ORG, APP, ENV)).toBe(
      `${BASE}/settings/general`,
    );
    expect(appPaths.developers.apiKeys(ORG, APP, ENV)).toBe(
      `${BASE}/settings/api-keys`,
    );
    expect(appPaths.developers.envVars(ORG, APP, ENV)).toBe(
      `${BASE}/settings/env-vars`,
    );
  });

  it("context is app-level — NO env segment (the documented exception)", () => {
    const url = appPaths.context.root(ORG, APP);
    expect(url).toBe(`/orgs/${ORG}/apps/${APP}/context`);
    expect(url).not.toContain("/env/");
  });
});
