/**
 * MSW-backed tests for the context save-path service's production ports.
 * Per apps/tenant-dashboard/CLAUDE.md: MSW at the Supabase HTTP boundary, a
 * real supabase-js client issues the queries — no query-chain mocks.
 *
 * `createGitProviderForApp` is mocked as a true seam: it performs GitHub
 * App token exchange, not a Supabase HTTP call worth exercising here (same
 * house pattern as `sections/apps/actions/actions.test.ts`).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  seedApiKeysMswState,
  seedContextSaveMswState,
  seedManagedDeploymentTablesState,
  seedSupabaseMswState,
} from "../../../test-helpers/msw-handlers";
import {
  createGitConnectionPort,
  createMirrorReadPort,
  createPolicyPort,
} from "./production-ports";

const mockCreateGitProviderForApp = vi.fn();
vi.mock("../git/connection", () => ({
  createGitProviderForApp: (...args: unknown[]) => mockCreateGitProviderForApp(...args),
}));

const SUPABASE_URL = "http://localhost:54321";
const SUPABASE_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";

function client(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) as unknown as SupabaseClient;
}

const APP_ID = "app-1";
const BRANCH = "main";

describe("createGitConnectionPort", () => {
  it("resolves provider + repository + branch when the app has a connection and a branch", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [
        { app_id: APP_ID, provider: "github", installation_id: 42, repository: "acme/widgets" },
      ],
    });
    seedApiKeysMswState({ gitBranches: [{ id: "branch-1", app_id: APP_ID, branch_name: BRANCH }] });
    const fakeProvider = { type: "github" } as unknown;
    mockCreateGitProviderForApp.mockResolvedValue(fakeProvider);

    const port = createGitConnectionPort(client());
    const result = await port.loadForApp(APP_ID);

    expect(result).toEqual({ provider: fakeProvider, repository: "acme/widgets", branch: BRANCH });
    expect(mockCreateGitProviderForApp).toHaveBeenCalledWith(expect.anything(), APP_ID);
  });

  it("returns null when the app has no git connection", async () => {
    seedApiKeysMswState({ gitBranches: [{ id: "branch-1", app_id: APP_ID, branch_name: BRANCH }] });

    const port = createGitConnectionPort(client());
    const result = await port.loadForApp(APP_ID);

    expect(result).toBeNull();
    expect(mockCreateGitProviderForApp).not.toHaveBeenCalled();
  });

  it("returns null when the app has a connection but no git_branch row", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [
        { app_id: APP_ID, provider: "github", installation_id: 42, repository: "acme/widgets" },
      ],
    });

    const port = createGitConnectionPort(client());
    const result = await port.loadForApp(APP_ID);

    expect(result).toBeNull();
    expect(mockCreateGitProviderForApp).not.toHaveBeenCalled();
  });

  it("returns null when createGitProviderForApp resolves null (e.g. auth failure)", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [
        { app_id: APP_ID, provider: "github", installation_id: 42, repository: "acme/widgets" },
      ],
    });
    seedApiKeysMswState({ gitBranches: [{ id: "branch-1", app_id: APP_ID, branch_name: BRANCH }] });
    mockCreateGitProviderForApp.mockResolvedValue(null);

    const port = createGitConnectionPort(client());
    const result = await port.loadForApp(APP_ID);

    expect(result).toBeNull();
  });
});

describe("createPolicyPort", () => {
  it("reads require_pull_request from the app row", async () => {
    seedSupabaseMswState({ apps: [{ id: APP_ID, tenant_id: "tenant-1", require_pull_request: true }] });

    const port = createPolicyPort(client());

    expect(await port.loadForApp(APP_ID)).toEqual({ requirePullRequest: true });
  });

  it("defaults to false when the column is unset", async () => {
    seedSupabaseMswState({ apps: [{ id: APP_ID, tenant_id: "tenant-1" }] });

    const port = createPolicyPort(client());

    expect(await port.loadForApp(APP_ID)).toEqual({ requirePullRequest: false });
  });
});

describe("createMirrorReadPort", () => {
  const SNAPSHOT_ID = "snap-1";

  it("headBlobSha returns the blob sha for a mirrored path", async () => {
    seedContextSaveMswState({
      contextHeads: [{ app_id: APP_ID, branch: BRANCH, snapshot_id: SNAPSHOT_ID }],
      contextTreeEntries: [
        { snapshot_id: SNAPSHOT_ID, path: ".outerlayer/AGENTS.md", blob_sha: "sha-1" },
      ],
    });

    const port = createMirrorReadPort(client());

    expect(await port.headBlobSha(APP_ID, BRANCH, ".outerlayer/AGENTS.md")).toBe("sha-1");
  });

  it("headBlobSha returns null when the path is not in the mirror", async () => {
    seedContextSaveMswState({
      contextHeads: [{ app_id: APP_ID, branch: BRANCH, snapshot_id: SNAPSHOT_ID }],
    });

    const port = createMirrorReadPort(client());

    expect(await port.headBlobSha(APP_ID, BRANCH, ".outerlayer/missing.md")).toBeNull();
  });

  it("headBlobSha returns null when there is no synced head for the branch", async () => {
    const port = createMirrorReadPort(client());

    expect(await port.headBlobSha(APP_ID, BRANCH, ".outerlayer/AGENTS.md")).toBeNull();
  });

  it("snapshotPaths lists every path under the prefix, positionally, excluding siblings", async () => {
    seedContextSaveMswState({
      contextHeads: [{ app_id: APP_ID, branch: BRANCH, snapshot_id: SNAPSHOT_ID }],
      contextTreeEntries: [
        { snapshot_id: SNAPSHOT_ID, path: ".outerlayer/skills/my-skill/SKILL.md", blob_sha: "sha-1" },
        {
          snapshot_id: SNAPSHOT_ID,
          path: ".outerlayer/skills/my-skill/references/notes.md",
          blob_sha: "sha-2",
        },
        // A sibling skill sharing the "my-skill" prefix textually — must NOT match.
        { snapshot_id: SNAPSHOT_ID, path: ".outerlayer/skills/my-skill-2/SKILL.md", blob_sha: "sha-3" },
        { snapshot_id: SNAPSHOT_ID, path: ".outerlayer/AGENTS.md", blob_sha: "sha-4" },
      ],
    });

    const port = createMirrorReadPort(client());
    const paths = await port.snapshotPaths(APP_ID, BRANCH, ".outerlayer/skills/my-skill");

    expect(paths).toEqual([
      ".outerlayer/skills/my-skill/SKILL.md",
      ".outerlayer/skills/my-skill/references/notes.md",
    ]);
  });

  it("snapshotPaths returns empty when there is no synced head for the branch", async () => {
    const port = createMirrorReadPort(client());

    expect(await port.snapshotPaths(APP_ID, BRANCH, ".outerlayer/skills/my-skill")).toEqual([]);
  });
});
