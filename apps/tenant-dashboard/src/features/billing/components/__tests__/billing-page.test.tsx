// @vitest-environment jsdom
/**
 * BillingPage — the React Server Component (RSC) tier-resolution glue. Pins the hobby/unknown/null →
 * setup-view fallback and the known-paid-tier → management-view branch,
 * plus the forbidden/error path: a denied `billing.read` must render as a
 * denial, never an empty page.
 */

import { render, screen } from "@testing-library/react";

const { loadBillingPageStateMock } = vi.hoisted(() => ({
  loadBillingPageStateMock: vi.fn(),
}));
vi.mock("../../read", () => ({ loadBillingPageState: loadBillingPageStateMock }));

vi.mock("../billing-setup", () => ({
  __esModule: true,
  default: ({ usage, storageGb }: { usage: number; storageGb: number }) => (
    <div data-testid="billing-setup">{`setup:${usage}:${storageGb}`}</div>
  ),
}));
vi.mock("../billing-management", () => ({
  __esModule: true,
  default: (props: { usage: number; storageGb: number; tierDisplayName: string; isCancelling: boolean }) => (
    <div data-testid="billing-management">
      {`management:${props.usage}:${props.storageGb}:${props.tierDisplayName}:${props.isCancelling}`}
    </div>
  ),
}));

import BillingPage from "../billing-page";

const basePageState = { units: 42, storageGb: 1.5, isCancelling: false, tierId: "growth" as const };

async function renderPage() {
  const el = await BillingPage();
  render(el);
}

describe("BillingPage", () => {
  it("renders the management view with usage/storage/tier for a known paid tier", async () => {
    loadBillingPageStateMock.mockResolvedValue({ ok: true, data: basePageState });

    await renderPage();

    expect(screen.getByTestId("billing-management")).toHaveTextContent("management:42:1.5:Growth:false");
    expect(screen.queryByTestId("billing-setup")).not.toBeInTheDocument();
  });

  it("renders the setup view when the tier is hobby", async () => {
    loadBillingPageStateMock.mockResolvedValue({ ok: true, data: { ...basePageState, tierId: "hobby" } });

    await renderPage();

    expect(screen.getByTestId("billing-setup")).toHaveTextContent("setup:42:1.5");
  });

  it("renders the setup view when the tier id is not a known tier", async () => {
    loadBillingPageStateMock.mockResolvedValue({ ok: true, data: { ...basePageState, tierId: "nonsense" } });

    await renderPage();

    expect(screen.getByTestId("billing-setup")).toBeInTheDocument();
  });

  it("renders the setup view when the tier id is null", async () => {
    loadBillingPageStateMock.mockResolvedValue({ ok: true, data: { ...basePageState, tierId: null } });

    await renderPage();

    expect(screen.getByTestId("billing-setup")).toBeInTheDocument();
  });

  it("passes the cancellation-pending flag through to the management view", async () => {
    loadBillingPageStateMock.mockResolvedValue({ ok: true, data: { ...basePageState, isCancelling: true } });

    await renderPage();

    expect(screen.getByTestId("billing-management")).toHaveTextContent("true");
  });

  it("renders a denial instead of an empty page when the read is forbidden", async () => {
    loadBillingPageStateMock.mockResolvedValue({ ok: false, error: "Permission denied: billing.read" });

    await renderPage();

    expect(screen.getByText("Permission denied: billing.read")).toBeInTheDocument();
    expect(screen.queryByTestId("billing-setup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("billing-management")).not.toBeInTheDocument();
  });
});
