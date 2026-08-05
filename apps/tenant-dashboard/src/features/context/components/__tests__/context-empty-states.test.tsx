// @vitest-environment jsdom
/**
 * Render tests for the empty/edge states. Each state must show its own
 * CTA, and the not-yet-wired Resync affordance must render DISABLED rather than
 * absent — it signals what is coming without acting.
 */
import { render, screen } from "@testing-library/react";
import {
  NeverSyncedState,
  NoContextFoundState,
  NoGitConnectionState,
  ResyncButton,
} from "../context-empty-states";

// Render with the real i18n + en.json so the CTA/title assertions prove the
// translation keys resolve to the shipped English copy.
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

describe("context empty states", () => {
  it("no git connection: routes the user to connect a repository", () => {
    render(<NoGitConnectionState connectHref="/orgs/o/apps/a/env/default/settings/general" />);
    expect(screen.getByText("No repository connected")).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /Connect a repository/ });
    expect(cta).toHaveAttribute("href", "/orgs/o/apps/a/env/default/settings/general");
  });

  it("connected but never synced: shows the set-up CTA and a disabled Resync", () => {
    render(<NeverSyncedState docsHref="https://docs.example/context" />);
    expect(screen.getByText("Set up context for this repo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Set up context/ })).toHaveAttribute("href", "https://docs.example/context");
    expect(screen.getByRole("button", { name: "Resync" })).toBeDisabled();
  });

  it("connected + synced but empty: shows the 'No context yet' CTA", () => {
    render(<NoContextFoundState docsHref="https://docs.example/context" />);
    expect(screen.getByText("No context yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Set up context/ })).toHaveAttribute("href", "https://docs.example/context");
  });

  it("Resync renders disabled until the sync action ships", () => {
    render(<ResyncButton />);
    expect(screen.getByRole("button", { name: "Resync" })).toBeDisabled();
  });
});
