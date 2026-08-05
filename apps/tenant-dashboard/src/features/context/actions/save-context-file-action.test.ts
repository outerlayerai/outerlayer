/**
 * Action-layer tests: input validation, permission gating, and the exact
 * call-through shape. The action-kit seams (`loadRequestServiceContext`,
 * `checkRequestPermission`) and the save-service / production-ports factories
 * are mocked; the real `authorizedAction` wrapper runs. The service itself is
 * exercised in `services/context-save/save-service.test.ts`, and the tenant
 * scoping of `ctx.db` in `lib/adapters/__tests__/request-service-context`.
 */

const mockUser = { id: "user-1", email: "ada@example.com", user_metadata: { display_name: "Ada Lovelace" } };
const fakeDb = { auth: { getUser: async () => ({ data: { user: mockUser } }) } };

const mockLoadCtx = vi.hoisted(() => vi.fn());
const mockCheckPerm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

const mockSaveContextFile = vi.hoisted(() => vi.fn());
// `resolveActor` is left real (spread from the actual module) — it's a pure
// mapping and the assertion below pins its output through the action.
vi.mock("../../../lib/adapters/context-save-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/adapters/context-save-write")>();
  return {
    ...actual,
    saveContextFile: mockSaveContextFile,
    createGitConnectionPort: vi.fn(() => "connection-port"),
    createPolicyPort: vi.fn(() => "policy-port"),
    createMirrorReadPort: vi.fn(() => "mirror-port"),
  };
});

import { saveContextFileAction } from "../action-adapters";

const VALID = { path: ".outerlayer/docs/setup.md", content: "updated", baseBlobSha: "sha-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue({ db: fakeDb, tenantId: "tenant-req", actor: { userId: "user-1", role: "admin" } });
  mockCheckPerm.mockResolvedValue(true);
});

describe("saveContextFileAction", () => {
  it("denies the save and never reaches the save-service when the user lacks context.update", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await saveContextFileAction("app-1", VALID);

    expect(result).toEqual({ error: "Permission denied: context.update" });
    expect(mockCheckPerm).toHaveBeenCalledWith({ userId: "user-1", role: "admin" }, "context.update", "app-1");
    expect(mockSaveContextFile).not.toHaveBeenCalled();
  });

  it("rejects invalid input before resolving the context or touching the service", async () => {
    const result = await saveContextFileAction("app-1", { ...VALID, path: "" });

    expect(result).toEqual({ error: "Input validation failed" });
    expect(mockLoadCtx).not.toHaveBeenCalled();
    expect(mockSaveContextFile).not.toHaveBeenCalled();
  });

  it("calls saveContextFile with baseBlobSha carried through and the resolved actor, wired through the production ports", async () => {
    mockSaveContextFile.mockResolvedValue({
      status: "saved",
      result: { landed: "branch", commitSha: "sha-2" },
      warnings: [],
    });

    const result = await saveContextFileAction("app-1", VALID);

    expect(result).toEqual({
      data: { status: "saved", result: { landed: "branch", commitSha: "sha-2" }, warnings: [] },
    });
    expect(mockSaveContextFile).toHaveBeenCalledWith(
      { connection: "connection-port", policy: "policy-port", mirror: "mirror-port" },
      {
        appId: "app-1",
        path: ".outerlayer/docs/setup.md",
        content: "updated",
        baseBlobSha: "sha-1",
        commitMessage: undefined,
        actor: { name: "Ada Lovelace", email: "ada@example.com" },
      },
    );
  });
});
