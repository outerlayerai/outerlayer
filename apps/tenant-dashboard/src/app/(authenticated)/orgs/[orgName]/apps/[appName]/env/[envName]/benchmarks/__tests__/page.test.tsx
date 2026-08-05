/**
 * The benchmarks React Server Component (RSC) resolves the app server-side and seeds the section's
 * appId, repo label, environment id, and run history — and renders the
 * escalation queue itself, seeded with its own read. It must: pass the
 * resolved appId/environmentId through and seed each read's rows, degrade
 * each of the four reads independently (no single read takes the page down),
 * and skip all four reads when the app can't be resolved.
 *
 * The two row-bearing reads additionally carry a failure FLAG to their own
 * surface. Both surfaces render an empty result as a positive claim — "no
 * benchmarks yet", and nothing at all for the self-hiding queue — so a
 * swallowed failure there does not merely lose information, it asserts
 * something false. The repo label and environment id have no such surface:
 * they degrade to a working default.
 *
 * The flag is fixed copy. The caught errors wrap PostgREST/Postgres text
 * verbatim, so threading a message into props would put relation names and
 * connection targets on a tenant's screen and bypass the framework's own
 * production redaction of thrown server errors. Every catch still logs, which
 * is the only place that detail belongs.
 */

import type { ReactElement } from "react";

const {
  getAppIdMock,
  getRepoLabelMock,
  loadEscalationsMock,
  loadRunsMock,
  loadRequestServiceContextMock,
  resolveEnvIdForStorageMock,
} = vi.hoisted(() => ({
  getAppIdMock: vi.fn(),
  getRepoLabelMock: vi.fn(),
  loadEscalationsMock: vi.fn(),
  loadRunsMock: vi.fn(),
  loadRequestServiceContextMock: vi.fn(),
  resolveEnvIdForStorageMock: vi.fn(),
}));
vi.mock("@/utils/get-app-id", () => ({ getAppIdByName: getAppIdMock }));
vi.mock("@/utils/get-app-repo-label", () => ({ getAppRepoLabel: getRepoLabelMock }));
vi.mock("@/features/escalations/read", () => ({ loadEscalationsForApp: loadEscalationsMock }));
vi.mock("@/features/escalations", () => ({ EscalationQueue: () => null }));
vi.mock("@/features/evals/read", () => ({ loadEvalRunsForApp: loadRunsMock }));
vi.mock("@/features/evals", () => ({ EvalsSection: () => null }));
vi.mock("@/lib/adapters", () => ({ loadRequestServiceContext: loadRequestServiceContextMock }));
vi.mock("@/lib/environments/env-scope", () => ({ resolveEnvIdForStorage: resolveEnvIdForStorageMock }));

import EvalsPage from "../page";

const params = (appName: string, envName = "dev") => Promise.resolve({ appName, envName });

function children(el: ReactElement): ReactElement[] {
  const kids = (el.props as { children: ReactElement | ReactElement[] }).children;
  return Array.isArray(kids) ? kids : [kids];
}

function queueProps(el: ReactElement): {
  appId: unknown;
  initialEscalations: unknown;
  readError: unknown;
} {
  return children(el)[0]!.props as {
    appId: unknown;
    initialEscalations: unknown;
    readError: unknown;
  };
}

function sectionProps(el: ReactElement): {
  appId: unknown;
  repoLabel: unknown;
  initialRuns: unknown;
  runsError: unknown;
  environmentId: unknown;
} {
  return children(el)[1]!.props as {
    appId: unknown;
    repoLabel: unknown;
    initialRuns: unknown;
    runsError: unknown;
    environmentId: unknown;
  };
}

beforeEach(() => {
  getAppIdMock.mockReset();
  getRepoLabelMock.mockReset();
  loadEscalationsMock.mockReset();
  loadRunsMock.mockReset();
  loadRequestServiceContextMock.mockReset();
  resolveEnvIdForStorageMock.mockReset();
  loadRequestServiceContextMock.mockResolvedValue({ db: "the-db-client" });
});

it("seeds the queue and section with the resolved app's id, repo label, environment id, and run history", async () => {
  getAppIdMock.mockResolvedValue("app-1");
  getRepoLabelMock.mockResolvedValue("acme/payments");
  loadEscalationsMock.mockResolvedValue([{ id: "e-1" }]);
  loadRunsMock.mockResolvedValue([{ id: "run-1" }]);
  resolveEnvIdForStorageMock.mockResolvedValue({ envId: "env-1", envName: "dev" });

  const el = await EvalsPage({ params: params("acme", "dev") });

  expect(getAppIdMock).toHaveBeenCalledWith("acme");
  expect(getRepoLabelMock).toHaveBeenCalledWith("app-1");
  expect(loadEscalationsMock).toHaveBeenCalledWith("app-1");
  expect(loadRunsMock).toHaveBeenCalledWith("app-1");
  expect(resolveEnvIdForStorageMock).toHaveBeenCalledWith("the-db-client", "app-1", { envName: "dev" });
  expect(queueProps(el)).toEqual({
    appId: "app-1",
    initialEscalations: [{ id: "e-1" }],
    readError: null,
  });
  expect(sectionProps(el)).toEqual({
    appId: "app-1",
    repoLabel: "acme/payments",
    initialRuns: [{ id: "run-1" }],
    runsError: null,
    environmentId: "env-1",
  });
});

it("hands the escalation queue its own read failure, without affecting run history or repo label", async () => {
  getAppIdMock.mockResolvedValue("app-1");
  getRepoLabelMock.mockResolvedValue("acme/payments");
  loadEscalationsMock.mockRejectedValue(
    new Error('list env_escalation failed: relation "env_escalation" does not exist'),
  );
  loadRunsMock.mockResolvedValue([{ id: "run-1" }]);
  resolveEnvIdForStorageMock.mockResolvedValue({ envId: "env-1", envName: "dev" });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const el = await EvalsPage({ params: params("acme") });

  expect(queueProps(el)).toEqual({
    appId: "app-1",
    initialEscalations: [],
    readError: "Couldn't load the environment build escalations.",
  });
  // The database's own text stays server-side.
  expect(JSON.stringify(queueProps(el))).not.toContain("env_escalation");
  expect(errSpy).toHaveBeenCalledWith(
    "[benchmarks] escalation queue read failed:",
    expect.any(Error),
  );
  expect(sectionProps(el)).toEqual({
    appId: "app-1",
    repoLabel: "acme/payments",
    initialRuns: [{ id: "run-1" }],
    runsError: null,
    environmentId: "env-1",
  });
  errSpy.mockRestore();
});

it("hands the section its own run-history read failure, without affecting the escalation queue or repo label", async () => {
  getAppIdMock.mockResolvedValue("app-1");
  getRepoLabelMock.mockResolvedValue("acme/payments");
  loadEscalationsMock.mockResolvedValue([{ id: "e-1" }]);
  loadRunsMock.mockRejectedValue(
    new Error('list eval_run failed: could not connect to server at "db.internal"'),
  );
  resolveEnvIdForStorageMock.mockResolvedValue({ envId: "env-1", envName: "dev" });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const el = await EvalsPage({ params: params("acme") });

  expect(queueProps(el)).toEqual({
    appId: "app-1",
    initialEscalations: [{ id: "e-1" }],
    readError: null,
  });
  expect(sectionProps(el)).toEqual({
    appId: "app-1",
    repoLabel: "acme/payments",
    initialRuns: [],
    runsError: "Couldn't load the run history.",
    environmentId: "env-1",
  });
  // The connection target stays server-side.
  expect(JSON.stringify(sectionProps(el))).not.toContain("db.internal");
  expect(errSpy).toHaveBeenCalledWith("[benchmarks] run history read failed:", expect.any(Error));
  errSpy.mockRestore();
});

it("degrades the repo label to a placeholder and logs when its read fails, without affecting escalations or run history", async () => {
  getAppIdMock.mockResolvedValue("app-1");
  getRepoLabelMock.mockRejectedValue(new Error("boom"));
  loadEscalationsMock.mockResolvedValue([{ id: "e-1" }]);
  loadRunsMock.mockResolvedValue([{ id: "run-1" }]);
  resolveEnvIdForStorageMock.mockResolvedValue({ envId: "env-1", envName: "dev" });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const el = await EvalsPage({ params: params("acme") });

  expect(queueProps(el)).toEqual({
    appId: "app-1",
    initialEscalations: [{ id: "e-1" }],
    readError: null,
  });
  expect(sectionProps(el)).toEqual({
    appId: "app-1",
    repoLabel: "your linked repo",
    initialRuns: [{ id: "run-1" }],
    runsError: null,
    environmentId: "env-1",
  });
  expect(errSpy).toHaveBeenCalledWith("[benchmarks] repo label read failed:", expect.any(Error));
  errSpy.mockRestore();
});

it("degrades the environment id to undefined and logs when its resolution fails, without affecting the other reads", async () => {
  getAppIdMock.mockResolvedValue("app-1");
  getRepoLabelMock.mockResolvedValue("acme/payments");
  loadEscalationsMock.mockResolvedValue([{ id: "e-1" }]);
  loadRunsMock.mockResolvedValue([{ id: "run-1" }]);
  resolveEnvIdForStorageMock.mockRejectedValue(new Error("boom"));
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const el = await EvalsPage({ params: params("acme") });

  expect(sectionProps(el)).toEqual({
    appId: "app-1",
    repoLabel: "acme/payments",
    initialRuns: [{ id: "run-1" }],
    runsError: null,
    environmentId: undefined,
  });
  expect(errSpy).toHaveBeenCalledWith(
    "[benchmarks] environment resolution failed:",
    expect.any(Error),
  );
  errSpy.mockRestore();
});

it("skips all four reads and seeds empty/placeholder when the app can't be resolved", async () => {
  getAppIdMock.mockResolvedValue(null);

  const el = await EvalsPage({ params: params("nope") });

  expect(getRepoLabelMock).not.toHaveBeenCalled();
  expect(loadEscalationsMock).not.toHaveBeenCalled();
  expect(loadRunsMock).not.toHaveBeenCalled();
  expect(resolveEnvIdForStorageMock).not.toHaveBeenCalled();
  expect(queueProps(el)).toEqual({
    appId: undefined,
    initialEscalations: [],
    readError: null,
  });
  expect(sectionProps(el)).toEqual({
    appId: undefined,
    repoLabel: "your linked repo",
    initialRuns: [],
    runsError: null,
    environmentId: undefined,
  });
});
