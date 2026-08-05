// @vitest-environment jsdom
/**
 * `useCurrentUser` — the narrow client-tier identity crossing. Only the
 * `useAuthContext` seam is mocked (globally, per unit-test-setup.ts); the
 * hook's own derivation (role from the snapshot a React Server Component (RSC)
 * seeds; isOwner) runs
 * for real.
 */
import { renderHook } from "@testing-library/react";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- test-only: overriding the globally-mocked seam `useCurrentUser` itself is built on (unit-test-setup.ts mocks @/auth/hooks for every test).
import { useAuthContext } from "@/auth/hooks";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- test-only: exercising the real provider to prove role comes from the seeded snapshot.
import { AppPermissionsProvider } from "@/auth/context/app-permissions-context";
import { useCurrentUser } from "./use-current-user";

describe("useCurrentUser", () => {
  it("returns undefined fields and isOwner=false when there is no authenticated user", () => {
    vi.mocked(useAuthContext).mockReturnValue({ user: null } as never);

    const { result } = renderHook(() => useCurrentUser());

    expect(result.current).toEqual({
      userId: undefined,
      email: undefined,
      role: undefined,
      isOwner: false,
    });
  });

  it("derives userId/email from the auth context user and role from the seeded snapshot, isOwner=false for a non-owner", () => {
    vi.mocked(useAuthContext).mockReturnValue({
      user: { id: "user-1", email: "ryan@example.com" },
    } as never);

    const { result } = renderHook(() => useCurrentUser(), {
      wrapper: ({ children }) => (
        <AppPermissionsProvider appId={null} permissions={[]} role="write">
          {children}
        </AppPermissionsProvider>
      ),
    });

    expect(result.current).toEqual({
      userId: "user-1",
      email: "ryan@example.com",
      role: "write",
      isOwner: false,
    });
  });

  it("sets isOwner=true only for the owner role", () => {
    vi.mocked(useAuthContext).mockReturnValue({
      user: { id: "user-2", email: "owner@example.com" },
    } as never);

    const { result } = renderHook(() => useCurrentUser(), {
      wrapper: ({ children }) => (
        <AppPermissionsProvider appId={null} permissions={[]} role="owner">
          {children}
        </AppPermissionsProvider>
      ),
    });

    expect(result.current.isOwner).toBe(true);
    expect(result.current.role).toBe("owner");
  });

  it("ignores a JWT role claim entirely, even one naming a different org's role", () => {
    vi.mocked(useAuthContext).mockReturnValue({
      user: { id: "user-3", email: "multi-org@example.com", app_metadata: { role: "write" } },
    } as never);

    const { result } = renderHook(() => useCurrentUser(), {
      wrapper: ({ children }) => (
        <AppPermissionsProvider appId={null} permissions={[]} role="owner">
          {children}
        </AppPermissionsProvider>
      ),
    });

    expect(result.current.role).toBe("owner");
    expect(result.current.isOwner).toBe(true);
  });

  it("returns an undefined role when no AppPermissionsProvider is mounted, never the JWT claim", () => {
    vi.mocked(useAuthContext).mockReturnValue({
      user: { id: "user-4", email: "solo@example.com", app_metadata: { role: "admin" } },
    } as never);

    const { result } = renderHook(() => useCurrentUser());

    expect(result.current.role).toBeUndefined();
    expect(result.current.isOwner).toBe(false);
  });
});
