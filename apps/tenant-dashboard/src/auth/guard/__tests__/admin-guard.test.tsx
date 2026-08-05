// @vitest-environment jsdom
/**
 * `<AdminGuard>` — the client-side gate on `/orgs/[orgName]/(admin)/**` and
 * `/platform-admin/**`. Keys off the role AuthProvider resolves for the URL
 * org.
 */
import { render, screen } from "@testing-library/react";

vi.mock("../../hooks", () => ({
  useAuthContext: vi.fn(),
}));
vi.mock("../../../sections/error/403-view", () => ({
  default: () => <div data-testid="forbidden-view" />,
}));

import { useAuthContext } from "../../hooks";
import AdminGuard from "../admin-guard";

function renderGuard() {
  return render(
    <AdminGuard>
      <div data-testid="admin-child" />
    </AdminGuard>,
  );
}

describe("AdminGuard", () => {
  it.each(["admin", "owner"] as const)("renders children for role=%s", (role) => {
    vi.mocked(useAuthContext).mockReturnValue({ user: { role } } as never);

    renderGuard();

    expect(screen.getByTestId("admin-child")).toBeInTheDocument();
    expect(screen.queryByTestId("forbidden-view")).not.toBeInTheDocument();
  });

  it("denies with ForbiddenView for a non-admin role", () => {
    vi.mocked(useAuthContext).mockReturnValue({ user: { role: "read" } } as never);

    renderGuard();

    expect(screen.getByTestId("forbidden-view")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-child")).not.toBeInTheDocument();
  });

  // An undefined role (no URL org resolved) denies rather than defaulting
  // open.
  it("denies when role is undefined", () => {
    vi.mocked(useAuthContext).mockReturnValue({ user: { role: undefined } } as never);

    renderGuard();

    expect(screen.getByTestId("forbidden-view")).toBeInTheDocument();
  });
});
