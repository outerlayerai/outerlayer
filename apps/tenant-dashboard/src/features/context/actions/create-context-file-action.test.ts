/**
 * Action-layer tests: input validation, permission gating, and the exact
 * call-through shape. The action-kit seams and the save-service / production
 * ports are mocked; the real `authorizedAction` wrapper runs.
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

import { createContextFileAction } from "../action-adapters";

const VALID = { path: ".outerlayer/docs/new.md", content: "hello" };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue({ db: fakeDb, tenantId: "tenant-req", actor: { userId: "user-1", role: "admin" } });
  mockCheckPerm.mockResolvedValue(true);
});

describe("createContextFileAction", () => {
  it("denies the create and never reaches the save-service when the user lacks context.insert", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await createContextFileAction("app-1", VALID);

    expect(result).toEqual({ error: "Permission denied: context.insert" });
    expect(mockCheckPerm).toHaveBeenCalledWith({ userId: "user-1", role: "admin" }, "context.insert", "app-1");
    expect(mockSaveContextFile).not.toHaveBeenCalled();
  });

  it("rejects invalid input before touching the service", async () => {
    const result = await createContextFileAction("app-1", { ...VALID, path: "" });

    expect(result).toEqual({ error: "Input validation failed" });
    expect(mockSaveContextFile).not.toHaveBeenCalled();
  });

  it("calls saveContextFile with a null base blob sha (marks it a create) and the resolved actor", async () => {
    mockSaveContextFile.mockResolvedValue({
      status: "saved",
      result: { landed: "branch", commitSha: "sha-2" },
      warnings: [],
    });

    const result = await createContextFileAction("app-1", VALID);

    expect(result).toEqual({
      data: { status: "saved", result: { landed: "branch", commitSha: "sha-2" }, warnings: [] },
    });
    expect(mockSaveContextFile).toHaveBeenCalledWith(
      { connection: "connection-port", policy: "policy-port", mirror: "mirror-port" },
      {
        appId: "app-1",
        path: ".outerlayer/docs/new.md",
        content: "hello",
        baseBlobSha: null,
        commitMessage: undefined,
        actor: { name: "Ada Lovelace", email: "ada@example.com" },
      },
    );
  });
});
