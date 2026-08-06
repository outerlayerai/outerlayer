/**
 * setPrCommentsEnabledAction — the glue around `authorizedAction`: validates
 * input, authorizes the app-scoped `git_connection.update` permission BEFORE
 * any write, then PATCHes `git_connection.pr_comments_enabled` for the
 * target app through the caller's tenant-scoped `ctx.db`.
 */

const { loadCtxMock, checkPermMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));

import { setPrCommentsEnabledAction } from "./actions";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";

function ctxDb() {
  const eq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ update });
  return { from, update, eq };
}

let db: ReturnType<typeof ctxDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = ctxDb();
  loadCtxMock.mockResolvedValue({
    db,
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  });
  checkPermMock.mockResolvedValue(true);
});

describe("setPrCommentsEnabledAction", () => {
  it("authorizes the app-scoped git_connection.update and PATCHes pr_comments_enabled on the target app's connection", async () => {
    const res = await setPrCommentsEnabledAction({ appId: APP_ID, value: false });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(checkPermMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "git_connection.update",
      APP_ID,
    );
    expect(db.from).toHaveBeenCalledWith("git_connection");
    expect(db.update).toHaveBeenCalledWith({ pr_comments_enabled: false });
    expect(db.eq).toHaveBeenCalledWith("app_id", APP_ID);
  });

  it("writes pr_comments_enabled=true when re-enabled", async () => {
    await setPrCommentsEnabledAction({ appId: APP_ID, value: true });

    expect(db.update).toHaveBeenCalledWith({ pr_comments_enabled: true });
  });

  it("surfaces a DB error message", async () => {
    db.eq.mockResolvedValueOnce({ error: { message: "update blocked" } });

    const res = await setPrCommentsEnabledAction({ appId: APP_ID, value: false });

    expect(res).toEqual({ ok: false, error: { code: "internal_error", message: "update blocked" } });
  });

  it("returns a permission error and never touches the DB when git_connection.update is denied", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await setPrCommentsEnabledAction({ appId: APP_ID, value: false });

    expect(res).toMatchObject({ ok: false, error: { code: "forbidden", message: "Permission denied: git_connection.update" } });
    expect(db.update).not.toHaveBeenCalled();
  });
});
