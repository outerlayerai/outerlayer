/**
 * `features/integrations/actions.ts` — the permission gate each of the 7
 * actions declares. The acceptance suites drive the service classes
 * directly, bypassing `authorizedAction`, so nothing else proves a caller
 * lacking the declared permission is actually refused before the service
 * runs. These tests mock the context/permission seams and every service
 * class, and assert a denial returns the specific `forbidden` code with no
 * service method ever called.
 */

const { loadCtxMock, checkPermMock, revalidateMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
  revalidateMock: vi.fn(),
}));
vi.mock("@/lib/adapters", () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const { envVarSetMock, envVarDeleteMock, envVarGetValueMock } = vi.hoisted(() => ({
  envVarSetMock: vi.fn(),
  envVarDeleteMock: vi.fn(),
  envVarGetValueMock: vi.fn(),
}));
// `mockImplementation` needs a real function, not an arrow function — an
// arrow function has no [[Construct]] slot, so `new EnvVarService()` (what
// the action handlers actually do) throws "is not a constructor" the moment
// a test exercises the allowed path instead of short-circuiting on denial.
vi.mock("./env-var-service", () => ({
  EnvVarService: vi.fn().mockImplementation(function () {
    return {
      set: envVarSetMock,
      delete: envVarDeleteMock,
      getValue: envVarGetValueMock,
    };
  }),
}));

import {
  deleteEnvVar,
  revealEnvVarValue,
  setEnvVar,
  setEnvVarForTargets,
} from "./actions";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const ENV_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const ENV_VAR_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

beforeEach(() => {
  vi.clearAllMocks();
  loadCtxMock.mockResolvedValue({
    db: {},
    tenantId: "tenant-1",
    actor: { userId: "user-1", role: "owner" },
  });
  envVarSetMock.mockResolvedValue({ id: "row-1", key: "KEY" });
  envVarDeleteMock.mockResolvedValue(undefined);
  envVarGetValueMock.mockResolvedValue("secret-value");
});

describe("setEnvVar", () => {
  it("denies without env_var.update — no set() call", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await setEnvVar({
      appId: APP_ID,
      scope: { environmentId: ENV_ID },
      key: "DATABASE_URL",
      value: "v",
    });

    expect(res).toStrictEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: env_var.update" },
    });
    expect(envVarSetMock).not.toHaveBeenCalled();
  });

  it("allowed: calls set() with the exact args and revalidates the env-vars page", async () => {
    checkPermMock.mockResolvedValue(true);

    const res = await setEnvVar({
      appId: APP_ID,
      scope: { environmentId: ENV_ID },
      key: "DATABASE_URL",
      value: "postgres://x",
    });

    expect(res).toStrictEqual({ ok: true, data: { id: "row-1", key: "KEY" } });
    expect(envVarSetMock).toHaveBeenCalledWith(
      APP_ID,
      { environmentId: ENV_ID },
      "tenant-1",
      "DATABASE_URL",
      "postgres://x",
    );
    expect(revalidateMock).toHaveBeenCalledWith(
      "/orgs/[orgName]/apps/[appName]/env/[envName]/settings/env-vars",
      "page",
    );
  });
});

describe("setEnvVarForTargets", () => {
  it("denies without env_var.insert — no set() call", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await setEnvVarForTargets({
      appId: APP_ID,
      scopes: [{ environmentId: ENV_ID }],
      key: "DATABASE_URL",
      value: "v",
    });

    expect(res).toStrictEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: env_var.insert" },
    });
    expect(envVarSetMock).not.toHaveBeenCalled();
  });

  it("allowed: calls set() once per scope, sequentially, and returns the applied count", async () => {
    checkPermMock.mockResolvedValue(true);
    const envId2 = "6c9b0813-0e02-4a1e-9c7c-2f1a3b4c5d6e";

    const res = await setEnvVarForTargets({
      appId: APP_ID,
      scopes: [{ environmentId: ENV_ID }, { environmentId: envId2 }],
      key: "DATABASE_URL",
      value: "v",
    });

    expect(res).toStrictEqual({ ok: true, data: { count: 2 } });
    expect(envVarSetMock).toHaveBeenNthCalledWith(
      1,
      APP_ID,
      { environmentId: ENV_ID },
      "tenant-1",
      "DATABASE_URL",
      "v",
    );
    expect(envVarSetMock).toHaveBeenNthCalledWith(
      2,
      APP_ID,
      { environmentId: envId2 },
      "tenant-1",
      "DATABASE_URL",
      "v",
    );
  });
});

describe("deleteEnvVar", () => {
  it("denies without env_var.delete — no delete() call", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await deleteEnvVar({ appId: APP_ID, envVarId: ENV_VAR_ID });

    expect(res).toStrictEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: env_var.delete" },
    });
    expect(envVarDeleteMock).not.toHaveBeenCalled();
  });

  it("allowed: calls delete() with (appId, envVarId) and revalidates the env-vars page", async () => {
    checkPermMock.mockResolvedValue(true);

    const res = await deleteEnvVar({ appId: APP_ID, envVarId: ENV_VAR_ID });

    expect(res).toStrictEqual({ ok: true, data: undefined });
    expect(envVarDeleteMock).toHaveBeenCalledWith(APP_ID, ENV_VAR_ID);
    expect(revalidateMock).toHaveBeenCalledWith(
      "/orgs/[orgName]/apps/[appName]/env/[envName]/settings/env-vars",
      "page",
    );
  });
});

describe("revealEnvVarValue", () => {
  it("denies without env_var.read — no getValue() call, no secret read", async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await revealEnvVarValue({ appId: APP_ID, envVarId: ENV_VAR_ID });

    expect(res).toStrictEqual({
      ok: false,
      error: { code: "forbidden", message: "Permission denied: env_var.read" },
    });
    expect(envVarGetValueMock).not.toHaveBeenCalled();
  });

  it("allowed: calls getValue() with (appId, envVarId) and returns the value wrapped", async () => {
    checkPermMock.mockResolvedValue(true);

    const res = await revealEnvVarValue({ appId: APP_ID, envVarId: ENV_VAR_ID });

    expect(res).toStrictEqual({ ok: true, data: { value: "secret-value" } });
    expect(envVarGetValueMock).toHaveBeenCalledWith(APP_ID, ENV_VAR_ID);
  });
});
