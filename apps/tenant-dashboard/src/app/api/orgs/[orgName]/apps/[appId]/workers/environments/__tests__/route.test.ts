/**
 * Route-layer contract for the workspace list: the loader receives the path
 * appId and the 200 body is exactly `{ environments }` around the loader
 * result.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadWorkerWorkspaces } = vi.hoisted(() => ({ mockLoadWorkerWorkspaces: vi.fn() }));

vi.mock("@/features/workers/read", () => ({ loadWorkerWorkspaces: mockLoadWorkerWorkspaces }));

import { GET } from "../route";

const context = { params: Promise.resolve({ orgName: "acme", appId: "app-1" }) };
const request = new Request("http://test.local/api/orgs/acme/apps/app-1/workers/environments");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET workers/environments", () => {
  it("loads workspaces for the path appId and envelopes them exactly", async () => {
    const rows = [{ id: "env-1", status: "idle" }, { id: "env-2", status: "busy" }];
    mockLoadWorkerWorkspaces.mockResolvedValue(rows);
    const res = await GET(request, context);
    expect(res.status).toBe(200);
    expect(mockLoadWorkerWorkspaces).toHaveBeenCalledWith("app-1");
    await expect(res.json()).resolves.toEqual({ environments: rows });
  });

  it("envelopes an empty workspace list as an empty array, not a missing key", async () => {
    mockLoadWorkerWorkspaces.mockResolvedValue([]);
    const res = await GET(request, context);
    await expect(res.json()).resolves.toEqual({ environments: [] });
  });
});
