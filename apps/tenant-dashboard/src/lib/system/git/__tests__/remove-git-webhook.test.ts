/**
 * Tests: removeGitWebhook — clears a stale `webhook_id` DB pointer when
 * disconnecting from a repository. GitHub webhooks are managed by the
 * GitHub App automatically, so this is purely a DB tidy, not an API call.
 *
 * Exercises the real `git_connection` select/update calls against MSW
 * (`test-helpers/msw-handlers/managed-deployment-tables.ts`) rather than a
 * hand-rolled client fake, so the actual query shape
 * (`select('webhook_id').eq('app_id', ...)`, `update(...).eq('app_id', ...)`)
 * is what's under test.
 */

import { createClient } from "@supabase/supabase-js";
import {
  seedManagedDeploymentTablesState,
  getUpdatedGitConnections,
} from "../../../../test-helpers/msw-handlers";
import { getSupabaseTestCookieStore } from "../../../../test-helpers/supabase-session";
import { removeGitWebhook } from "../remove-git-webhook";

const SUPABASE_URL = "http://localhost:54321";

const mockCaptureException = vi.fn();
vi.mock("@/lib/observability/error-reporting/sentry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// Overrides the global `next/headers` mock (which resolves no tenant header)
// so the no-client fallback test below can assert the request-tenant it
// resolves actually reaches the Supabase client as `X-Tenant-Id`.
const headersGet = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => ({ get: headersGet }),
  cookies: () => getSupabaseTestCookieStore(),
}));

const supabase = createClient(SUPABASE_URL, "test-anon-key");

describe("removeGitWebhook", () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
    headersGet.mockReset();
  });

  it("clears webhook_id when the connection carries one", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: "app-1", provider: "github", installation_id: 1, webhook_id: "wh-1" }],
    });

    const result = await removeGitWebhook("app-1", supabase);

    expect(result).toBeUndefined();
    expect(getUpdatedGitConnections()).toEqual([
      { appId: "app-1", patch: { webhook_id: null }, tenantHeader: null },
    ]);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("does nothing when the connection has no webhook_id", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: "app-2", provider: "github", installation_id: 1, webhook_id: null }],
    });

    const result = await removeGitWebhook("app-2", supabase);

    expect(result).toBeUndefined();
    expect(getUpdatedGitConnections()).toEqual([]);
  });

  it("does nothing when no connection row is found", async () => {
    seedManagedDeploymentTablesState({ gitConnections: [] });

    const result = await removeGitWebhook("app-3", supabase);

    expect(result).toBeUndefined();
    expect(getUpdatedGitConnections()).toEqual([]);
  });

  it("swallows a failed update and captures it to Sentry with context", async () => {
    // A network-level PostgREST failure resolves to `{ error }` rather than
    // rejecting (postgrest-js swallows fetch errors internally unless
    // `.throwOnError()` is set), so the production `catch` only guards a
    // synchronous throw from the query chain itself — simulate that directly
    // rather than through MSW.
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: "app-42", provider: "github", installation_id: 1, webhook_id: "wh-42" }],
    });
    const failingClient = createClient(SUPABASE_URL, "test-anon-key");
    vi.spyOn(failingClient, "from").mockImplementation(((table: string) => {
      if (table !== "git_connection") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { webhook_id: "wh-42" }, error: null }),
          }),
        }),
        update: () => ({
          eq: () => {
            throw new Error("DB unreachable");
          },
        }),
      };
    }) as unknown as typeof failingClient.from);

    await expect(removeGitWebhook("app-42", failingClient)).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [capturedError, capturedContext] = mockCaptureException.mock.calls[0]!;
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain("DB unreachable");
    expect(capturedContext).toMatchObject({
      extra: { appId: "app-42", webhookId: "wh-42" },
    });
  });

  it("without an injected client, falls back to the request-tenant-scoped server client (app-deletion-service's call site)", async () => {
    // app-deletion-service.ts's `AppDeletionConfig.removeGitWebhook` is typed
    // `(appId: string) => Promise<unknown>` — the production wiring never
    // passes a client, so this exercises the
    // `client ?? getRequestDataClient(await getRequestTenantId())`
    // fallback at remove-git-webhook.ts:22 directly, asserting the request
    // actually carries the resolved tenant (not an unscoped or service-role
    // client, neither of which would attach `X-Tenant-Id`).
    headersGet.mockImplementation((name: string) => (name === "x-tenant-id" ? "tenant-5" : null));
    seedManagedDeploymentTablesState({
      gitConnections: [{ app_id: "app-5", provider: "github", installation_id: 1, webhook_id: "wh-5" }],
    });

    const result = await removeGitWebhook("app-5");

    expect(result).toBeUndefined();
    expect(getUpdatedGitConnections()).toEqual([
      { appId: "app-5", patch: { webhook_id: null }, tenantHeader: "tenant-5" },
    ]);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
