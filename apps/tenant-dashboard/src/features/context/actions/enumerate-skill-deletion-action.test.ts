/**
 * Action-layer tests: input validation, permission gating (`context.read`), and
 * the exact call-through to the backend `enumerateSkillDeletion` service. The
 * action-kit seams and the production-ports factories are mocked; the real
 * `authorizedAction` wrapper runs.
 */

const fakeDb = { auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };

const mockLoadCtx = vi.hoisted(() => vi.fn());
const mockCheckPerm = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

const mockEnumerateSkillDeletion = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/adapters/context-save-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/adapters/context-save-write")>();
  return {
    ...actual,
    enumerateSkillDeletion: mockEnumerateSkillDeletion,
    createGitConnectionPort: vi.fn(() => "connection-port"),
    createPolicyPort: vi.fn(() => "policy-port"),
    createMirrorReadPort: vi.fn(() => "mirror-port"),
  };
});

import { enumerateSkillDeletionAction } from "../action-adapters";

const SKILL_DIR = ".outerlayer/skills/deploy-checklist";

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCtx.mockResolvedValue({ db: fakeDb, tenantId: "tenant-req", actor: { userId: "user-1", role: "read" } });
  mockCheckPerm.mockResolvedValue(true);
});

describe("enumerateSkillDeletionAction", () => {
  it("denies enumeration and never reaches the service when the user lacks context.read", async () => {
    mockCheckPerm.mockResolvedValue(false);

    const result = await enumerateSkillDeletionAction("app-1", SKILL_DIR);

    expect(result).toEqual({ error: "Permission denied: context.read" });
    expect(mockCheckPerm).toHaveBeenCalledWith({ userId: "user-1", role: "read" }, "context.read", "app-1");
    expect(mockEnumerateSkillDeletion).not.toHaveBeenCalled();
  });

  it("rejects an empty skill dir before touching the service", async () => {
    const result = await enumerateSkillDeletionAction("app-1", "");

    expect(result).toEqual({ error: "Input validation failed" });
    expect(mockEnumerateSkillDeletion).not.toHaveBeenCalled();
  });

  it("returns the enumeration wired through the production ports, scoped to the app + skill dir", async () => {
    const enumeration = {
      status: "ok",
      enumeration: {
        paths: [`${SKILL_DIR}/SKILL.md`, `${SKILL_DIR}/assets/logo.png`],
        assetPaths: [`${SKILL_DIR}/assets/logo.png`],
      },
    };
    mockEnumerateSkillDeletion.mockResolvedValue(enumeration);

    const result = await enumerateSkillDeletionAction("app-1", SKILL_DIR);

    expect(mockCheckPerm).toHaveBeenCalledWith(expect.anything(), "context.read", "app-1");
    expect(mockEnumerateSkillDeletion).toHaveBeenCalledWith(
      { connection: "connection-port", policy: "policy-port", mirror: "mirror-port" },
      "app-1",
      SKILL_DIR,
    );
    expect(result).toEqual({ data: enumeration });
  });

  it("passes a not_connected outcome straight through as data", async () => {
    mockEnumerateSkillDeletion.mockResolvedValue({ status: "not_connected" });

    const result = await enumerateSkillDeletionAction("app-1", SKILL_DIR);
    expect(result).toEqual({ data: { status: "not_connected" } });
  });
});
