/**
 * Action-layer tests: the composed permission gate (`context.update` iff the
 * batch edits a file, `context.insert` iff it creates one, `context.delete`
 * iff it deletes one — a batch never demands a permission its own change
 * types don't call for) + exact call-through shape. The action-kit seams,
 * `checkAppPermission` (the mixed-batch secondary check), and the save-service /
 * production-ports factories are mocked; the real `authorizedAction` wrapper
 * runs. The service itself is covered in `services/context-save/save-service`.
 */

const mockUser = { id: "user-1", email: "reviewer@example.com", user_metadata: { display_name: "Jordan Reviewer" } };
const fakeDb = { auth: { getUser: async () => ({ data: { user: mockUser } }) } };

const mockLoadCtx = vi.hoisted(() => vi.fn());
const mockCheckPerm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

const mockCheckAppPermission = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/permission-check", () => ({
  checkAppPermission: mockCheckAppPermission,
}));

const mockCommitContextChanges = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/adapters/context-save-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/adapters/context-save-write")>();
  return {
    ...actual,
    commitContextChanges: mockCommitContextChanges,
    createGitConnectionPort: vi.fn(() => "connection-port"),
    createPolicyPort: vi.fn(() => "policy-port"),
    createMirrorReadPort: vi.fn(() => "mirror-port"),
  };
});

import { commitContextChangesAction } from "../action-adapters";

const SAVED = { status: "saved", result: { landed: "branch", commitSha: "batch-sha" }, warnings: [] };

const EDIT_A = { path: ".outerlayer/docs/setup.md", content: "# a", baseBlobSha: "sha-1" };
const EDIT_B = { path: ".outerlayer/docs/deploy.md", content: "# b", baseBlobSha: "sha-2" };
const CREATE_A = { path: ".outerlayer/docs/new.md", content: "# new", baseBlobSha: null };
const DELETE_A = { path: ".outerlayer/docs/old.md", content: "", baseBlobSha: "sha-3", delete: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue({ db: fakeDb, tenantId: "tenant-req", actor: { userId: "user-1", role: "admin" } });
  mockCheckPerm.mockResolvedValue(true);
  mockCheckAppPermission.mockResolvedValue({ user: mockUser });
  mockCommitContextChanges.mockResolvedValue(SAVED);
});

describe("commitContextChangesAction", () => {
  describe("edit-only batch (context.update only)", () => {
    it("gates on context.update, never checks insert, and denies without reaching the service", async () => {
      mockCheckPerm.mockResolvedValue(false);

      const result = await commitContextChangesAction("app-1", { files: [EDIT_A] });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.update", "app-1");
      expect(mockCheckAppPermission).not.toHaveBeenCalled();
      expect(result).toEqual({ error: "Permission denied: context.update" });
      expect(mockCommitContextChanges).not.toHaveBeenCalled();
    });

    it("commits through the ports when granted, never checking insert", async () => {
      const result = await commitContextChangesAction("app-1", {
        message: "Refresh docs",
        files: [EDIT_A, EDIT_B],
      });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.update", "app-1");
      expect(mockCheckAppPermission).not.toHaveBeenCalled();
      expect(result).toEqual({ data: SAVED });
      expect(mockCommitContextChanges).toHaveBeenCalledWith(
        { connection: "connection-port", policy: "policy-port", mirror: "mirror-port" },
        {
          appId: "app-1",
          message: "Refresh docs",
          files: [EDIT_A, EDIT_B],
          actor: { name: "Jordan Reviewer", email: "reviewer@example.com" },
        },
      );
    });
  });

  describe("create-only batch (context.insert only — must NOT demand update)", () => {
    it("gates on context.insert, never checks update, and denies without reaching the service", async () => {
      mockCheckPerm.mockResolvedValue(false);

      const result = await commitContextChangesAction("app-1", { files: [CREATE_A] });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.insert", "app-1");
      // The wrapper is the only gate — no second (update) check for a create-only batch.
      expect(mockCheckAppPermission).not.toHaveBeenCalled();
      expect(result).toEqual({ error: "Permission denied: context.insert" });
      expect(mockCommitContextChanges).not.toHaveBeenCalled();
    });

    it("commits through the ports when insert is granted, never demanding update", async () => {
      const result = await commitContextChangesAction("app-1", { files: [CREATE_A] });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.insert", "app-1");
      expect(mockCheckAppPermission).not.toHaveBeenCalled();
      expect(result).toEqual({ data: SAVED });
      expect(mockCommitContextChanges).toHaveBeenCalledTimes(1);
    });
  });

  describe("delete-only batch (context.delete only — must NOT demand update or insert)", () => {
    it("gates on context.delete, never checks another permission, and denies without reaching the service", async () => {
      mockCheckPerm.mockResolvedValue(false);

      const result = await commitContextChangesAction("app-1", { files: [DELETE_A] });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.delete", "app-1");
      expect(mockCheckAppPermission).not.toHaveBeenCalled();
      expect(result).toEqual({ error: "Permission denied: context.delete" });
      expect(mockCommitContextChanges).not.toHaveBeenCalled();
    });

    it("commits through the ports when delete is granted, never demanding update or insert", async () => {
      const result = await commitContextChangesAction("app-1", { files: [DELETE_A] });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.delete", "app-1");
      expect(mockCheckAppPermission).not.toHaveBeenCalled();
      expect(result).toEqual({ data: SAVED });
      expect(mockCommitContextChanges).toHaveBeenCalledWith(
        { connection: "connection-port", policy: "policy-port", mirror: "mirror-port" },
        {
          appId: "app-1",
          message: undefined,
          files: [DELETE_A],
          actor: { name: "Jordan Reviewer", email: "reviewer@example.com" },
        },
      );
    });
  });

  describe("mixed batch (both context.update and context.insert)", () => {
    it("denies at the wrapper when update is missing, before checking insert or the service", async () => {
      mockCheckPerm.mockResolvedValue(false);

      const result = await commitContextChangesAction("app-1", { files: [EDIT_A, CREATE_A] });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.update", "app-1");
      expect(mockCheckAppPermission).not.toHaveBeenCalled();
      expect(result).toEqual({ error: "Permission denied: context.update" });
      expect(mockCommitContextChanges).not.toHaveBeenCalled();
    });

    it("denies at the explicit insert check when update passes but insert is missing", async () => {
      mockCheckAppPermission.mockResolvedValue({
        user: mockUser,
        error: "Access denied. Required permission: context.insert",
      });

      const result = await commitContextChangesAction("app-1", { files: [EDIT_A, CREATE_A] });

      expect(mockCheckAppPermission).toHaveBeenCalledWith("context.insert", "app-1");
      expect(result).toEqual({ error: "Access denied. Required permission: context.insert" });
      expect(mockCommitContextChanges).not.toHaveBeenCalled();
    });

    it("commits when both update and insert are granted", async () => {
      const result = await commitContextChangesAction("app-1", { files: [EDIT_A, CREATE_A] });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.update", "app-1");
      expect(mockCheckAppPermission).toHaveBeenCalledWith("context.insert", "app-1");
      expect(result).toEqual({ data: SAVED });
      expect(mockCommitContextChanges).toHaveBeenCalledTimes(1);
    });
  });

  describe("mixed edit + create + delete batch (all three grants)", () => {
    it("gates on update, then checks insert and delete explicitly, in that order", async () => {
      const result = await commitContextChangesAction("app-1", { files: [EDIT_A, CREATE_A, DELETE_A] });

      expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.update", "app-1");
      expect(mockCheckAppPermission).toHaveBeenNthCalledWith(1, "context.insert", "app-1");
      expect(mockCheckAppPermission).toHaveBeenNthCalledWith(2, "context.delete", "app-1");
      expect(result).toEqual({ data: SAVED });
      expect(mockCommitContextChanges).toHaveBeenCalledTimes(1);
    });

    it("denies at the explicit delete check when update and insert pass but delete is missing", async () => {
      mockCheckAppPermission
        .mockResolvedValueOnce({ user: mockUser })
        .mockResolvedValueOnce({ user: mockUser, error: "Access denied. Required permission: context.delete" });

      const result = await commitContextChangesAction("app-1", { files: [EDIT_A, CREATE_A, DELETE_A] });

      expect(mockCheckAppPermission).toHaveBeenNthCalledWith(2, "context.delete", "app-1");
      expect(result).toEqual({ error: "Access denied. Required permission: context.delete" });
      expect(mockCommitContextChanges).not.toHaveBeenCalled();
    });
  });

  describe("batch-size cap (schema validation)", () => {
    function filesOf(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        path: `.outerlayer/docs/file-${i}.md`,
        content: "x",
        baseBlobSha: null as string | null,
      }));
    }

    it("surfaces a batch over the 1000-file cap as a plain error carrying the cap message, never reaching the service", async () => {
      const result = await commitContextChangesAction("app-1", { files: filesOf(1001) });

      // A schema rejection has no per-draft path to key a `validation_error`
      // outcome's row highlighting against, so it surfaces through the plain
      // error path (rendered in the dialog's error Alert) instead.
      expect(result).toEqual({ error: "a batch commits at most 1000 files at once" });
      expect(mockCommitContextChanges).not.toHaveBeenCalled();
    });

    it("commits a batch at exactly the 1000-file cap", async () => {
      const result = await commitContextChangesAction("app-1", { files: filesOf(1000) });

      expect(result).toEqual({ data: SAVED });
      expect(mockCommitContextChanges).toHaveBeenCalledTimes(1);
    });
  });
});
