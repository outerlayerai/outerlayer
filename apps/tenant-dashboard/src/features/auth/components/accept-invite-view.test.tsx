// @vitest-environment jsdom
/**
 * State-machine coverage for `AcceptInviteView` — an 8-state client component
 * (loading/error/expired/ready/accepting/success/already_accepted/
 * org_limit_reached). Each test pins one transition against a mocked
 * server-action boundary, so a regression in the state machine itself — not
 * the network — fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const acceptInvitationAction = vi.hoisted(() => vi.fn());
const getInvitationDetailsAction = vi.hoisted(() => vi.fn());
const checkTermsForInvitationAction = vi.hoisted(() => vi.fn());
vi.mock("../action-adapters", () => ({
  acceptInvitationAction,
  getInvitationDetailsAction,
  checkTermsForInvitationAction,
}));

const searchParamsState = vi.hoisted(() => ({ id: "membership-123" as string | null }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => (key === "id" ? searchParamsState.id : null) }),
}));

// A stable `t` reference, matching the real `useTranslate` (react-i18next's
// `useTranslation`, which memoizes `t` across renders). A fresh function
// identity per call would make `loadInvitation`'s `useCallback([membershipId,
// t])` recreate every render, re-firing the mount effect in an infinite
// setState loop that never settles.
const stableT = vi.hoisted(
  () => (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
);
vi.mock("@outerlayer/locales", () => ({
  useTranslate: () => ({ t: stableT }),
}));

vi.mock("@/routes/paths", () => ({
  paths: { dashboard: { root: "/dashboard" } },
}));

vi.mock("@/routes/components", () => ({
  RouterLink: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

vi.mock("@/components/iconify", () => ({
  default: () => null,
}));

const refreshSession = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/adapters/supabase-frontend-client", () => ({
  createSupabaseFontendClient: () => ({ auth: { refreshSession } }),
}));

import AcceptInviteView from "./accept-invite-view";

const READY_DETAILS = {
  id: "membership-123",
  companyName: "Acme Co",
  organizationName: "acme",
  isExpired: false,
  expiresAt: "2099-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  searchParamsState.id = "membership-123";
  checkTermsForInvitationAction.mockResolvedValue({ data: { needsAgreement: false, currentVersion: "v1" } });
});

describe("AcceptInviteView — invitation loading", () => {
  it("shows the loading state while the invitation fetch is pending", () => {
    getInvitationDetailsAction.mockReturnValue(new Promise(() => {}));
    render(<AcceptInviteView />);

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText("auth.acceptInvite.title")).toBeNull();
  });

  it("shows the invalid-link error state when the URL carries no membership id", async () => {
    searchParamsState.id = null;
    render(<AcceptInviteView />);

    expect(await screen.findByText("auth.acceptInvite.error.title")).toBeInTheDocument();
    expect(getInvitationDetailsAction).not.toHaveBeenCalled();
  });

  it("shows a generic error state when the invitation lookup fails", async () => {
    getInvitationDetailsAction.mockResolvedValue({ error: "Invitation not found" });
    render(<AcceptInviteView />);

    expect(await screen.findByText("auth.acceptInvite.error.title")).toBeInTheDocument();
    expect(screen.getByText("Invitation not found")).toBeInTheDocument();
  });

  it('routes the "already_accepted" error to its own state, not the generic error state', async () => {
    getInvitationDetailsAction.mockResolvedValue({ error: "already_accepted" });
    render(<AcceptInviteView />);

    expect(await screen.findByText("auth.acceptInvite.alreadyAccepted.title")).toBeInTheDocument();
    expect(screen.queryByText("auth.acceptInvite.error.title")).toBeNull();
  });

  it("shows the expired state when the invitation is expired", async () => {
    getInvitationDetailsAction.mockResolvedValue({
      data: { ...READY_DETAILS, isExpired: true },
    });
    render(<AcceptInviteView />);

    expect(await screen.findByText("auth.acceptInvite.expired.title")).toBeInTheDocument();
  });

  it("reaches the ready state and shows no terms checkbox when the user already agreed", async () => {
    getInvitationDetailsAction.mockResolvedValue({ data: READY_DETAILS });
    render(<AcceptInviteView />);

    expect(await screen.findByText("auth.acceptInvite.title")).toBeInTheDocument();
    expect(screen.queryByTestId("terms-checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "auth.acceptInvite.acceptButton" })).not.toBeDisabled();
  });

  it("shows the terms checkbox, disabled accept, when the user needs to agree", async () => {
    getInvitationDetailsAction.mockResolvedValue({ data: READY_DETAILS });
    checkTermsForInvitationAction.mockResolvedValue({ data: { needsAgreement: true, currentVersion: "v1" } });
    render(<AcceptInviteView />);

    expect(await screen.findByTestId("terms-checkbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "auth.acceptInvite.acceptButton" })).toBeDisabled();
  });
});

describe("AcceptInviteView — accepting", () => {
  beforeEach(() => {
    getInvitationDetailsAction.mockResolvedValue({ data: READY_DETAILS });
  });

  it("shows the accepting state while the server action is in flight, then success", async () => {
    let resolveAccept!: (v: unknown) => void;
    acceptInvitationAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAccept = resolve;
      }),
    );
    render(<AcceptInviteView />);

    fireEvent.click(await screen.findByRole("button", { name: "auth.acceptInvite.acceptButton" }));

    expect(await screen.findByText("auth.acceptInvite.accepting")).toBeInTheDocument();

    await act(async () => {
      resolveAccept({ data: { tenantId: "tenant-1", companyName: "Acme Co" } });
    });

    expect(await screen.findByText("auth.acceptInvite.success.title")).toBeInTheDocument();
    expect(refreshSession).toHaveBeenCalledWith();
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('routes an "expired" result back to the expired state', async () => {
    acceptInvitationAction.mockResolvedValue({ error: "expired" });
    render(<AcceptInviteView />);

    fireEvent.click(await screen.findByRole("button", { name: "auth.acceptInvite.acceptButton" }));

    expect(await screen.findByText("auth.acceptInvite.expired.title")).toBeInTheDocument();
  });

  it("routes an org-limit error to the org_limit_reached state", async () => {
    acceptInvitationAction.mockResolvedValue({
      error: "You have reached the maximum of 10 organizations. Leave an organization to accept this invitation.",
    });
    render(<AcceptInviteView />);

    fireEvent.click(await screen.findByRole("button", { name: "auth.acceptInvite.acceptButton" }));

    expect(await screen.findByText("auth.acceptInvite.orgLimitReached.title")).toBeInTheDocument();
  });

  it("keeps the accept button disabled — never dispatching the action — until terms are checked", async () => {
    checkTermsForInvitationAction.mockResolvedValue({ data: { needsAgreement: true, currentVersion: "v1" } });
    render(<AcceptInviteView />);

    const acceptButton = await screen.findByRole("button", { name: "auth.acceptInvite.acceptButton" });
    expect(acceptButton).toBeDisabled();
    expect(acceptInvitationAction).not.toHaveBeenCalled();
  });

  it("dispatches acceptance with agreedToTerms=true once the checkbox is checked", async () => {
    checkTermsForInvitationAction.mockResolvedValue({ data: { needsAgreement: true, currentVersion: "v1" } });
    acceptInvitationAction.mockResolvedValue({ data: { tenantId: "tenant-1", companyName: "Acme Co" } });
    render(<AcceptInviteView />);

    fireEvent.click(await screen.findByTestId("terms-checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "auth.acceptInvite.acceptButton" }));

    await waitFor(() => expect(acceptInvitationAction).toHaveBeenCalledWith("membership-123", true));
  });
});
