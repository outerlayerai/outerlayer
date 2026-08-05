/**
 * startGitConnectAction — the glue around `authorizedAction`: authorizes the
 * app-scoped `app.update` before minting the OAuth URL, and translates the
 * gateway's 503 `git_connect_not_configured` into the shape the two callers
 * (apps-list settings menu, onboarding's repo-connect gate) branch on.
 */

const { loadCtxMock, checkPermMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));

const { startGitConnectFromServerMock, AppsApiErrorMock } = vi.hoisted(() => {
  class AppsApiError extends Error {
    status: number;
    code: string;
    extras: Record<string, unknown>;
    constructor(status: number, code: string, message: string, extras: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.extras = extras;
    }
  }
  return { startGitConnectFromServerMock: vi.fn(), AppsApiErrorMock: AppsApiError };
});
vi.mock("@/lib/apps/server-client", () => ({
  AppsApiError: AppsApiErrorMock,
  startGitConnectFromServer: startGitConnectFromServerMock,
}));

import { startGitConnectAction } from "./start-git-connect-action";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  vi.clearAllMocks();
  loadCtxMock.mockResolvedValue({
    db: {},
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
});

it("authorizes app.update on the target app and mints the authorization URL", async () => {
  startGitConnectFromServerMock.mockResolvedValue({
    authorization_url: "https://github.example/authorize?state=abc",
    state: "abc",
    expires_at: "2026-07-28T00:10:00.000Z",
  });

  const res = await startGitConnectAction({ appId: APP_ID, provider: "github" });

  expect(res).toEqual({
    ok: true,
    data: { ok: true, authorizationUrl: "https://github.example/authorize?state=abc" },
  });
  expect(checkPermMock).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "user-1" }),
    "app.update",
    APP_ID,
  );
  expect(startGitConnectFromServerMock).toHaveBeenCalledWith(APP_ID, { provider: "github" });
});

it("refuses a caller without app.update on this app, before any gateway call", async () => {
  checkPermMock.mockResolvedValue(false);

  const res = await startGitConnectAction({ appId: APP_ID, provider: "github" });

  expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(startGitConnectFromServerMock).not.toHaveBeenCalled();
});

it("maps a 503 git_connect_not_configured into a distinguishable domain failure", async () => {
  startGitConnectFromServerMock.mockRejectedValue(
    new AppsApiErrorMock(503, "git_connect_not_configured", "Git connect is unavailable"),
  );

  const res = await startGitConnectAction({ appId: APP_ID, provider: "github" });

  expect(res).toEqual({
    ok: true,
    data: {
      ok: false,
      errorCode: "git_connect_not_configured",
      message: "Git connect is unavailable",
    },
  });
});

it("rejects a non-github provider at the schema before any gateway call", async () => {
  const res = await startGitConnectAction({ appId: APP_ID, provider: "gitlab" });

  expect(res).toMatchObject({ ok: false, error: { code: "validation_error" } });
  expect(startGitConnectFromServerMock).not.toHaveBeenCalled();
});
