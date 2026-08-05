import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockUser } from "@/test-helpers/fixtures/auth.fixtures";
import { seedSupabaseAuth } from "@/test-helpers/msw-handlers";

/**
 * Every export of a `"use server"` module is a public POST endpoint, so this was
 * an unauthenticated cache-purge primitive: loop it on `'/'` and every request
 * forces a full server re-render. Cost amplification only — it exposes no data —
 * and the `/auth/**` middleware exemption meant even a signed-out caller reached
 * it.
 *
 * The signed-out case is expressed by NOT seeding a session: the MSW auth
 * handlers default to no session, so the real Supabase server client resolves a
 * null user exactly as it would in production.
 */

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

// The global unit-test setup mocks `../utils/actions` wholesale so component
// tests do not hit a real server action. This file is testing that module
// itself, so it opts out and loads the real implementation.
vi.unmock("../actions");

let revalidateServerPath: (path: string) => Promise<void>;

beforeEach(async () => {
  revalidatePath.mockReset();
  ({ revalidateServerPath } = await import("../actions"));
});

describe("revalidateServerPath", () => {
  it("purges the path for a signed-in caller", async () => {
    seedSupabaseAuth({ user: mockUser });

    await revalidateServerPath("/orgs/acme/apps");

    expect(revalidatePath).toHaveBeenCalledWith("/orgs/acme/apps");
  });

  it("does nothing for an unauthenticated caller", async () => {
    // No seedSupabaseAuth — there is no session.
    await revalidateServerPath("/");

    // The property that matters: no purge happens at all, so the amplification
    // is gone rather than merely rate-limited.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("no-ops rather than throwing, since callers do not branch on the outcome", async () => {
    await expect(revalidateServerPath("/")).resolves.toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
