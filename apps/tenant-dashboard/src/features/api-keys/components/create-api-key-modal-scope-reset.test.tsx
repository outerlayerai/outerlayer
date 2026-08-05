// @vitest-environment jsdom
/**
 * Regression: the create-key modal must start every fresh open from the default
 * "pin to current env" scope. rhf reset() only clears the name field, so the
 * env-scope local state (kindScoped / selectedKinds) has to be cleared
 * explicitly: left to persist, a reopen after minting a kind-scoped key shows
 * "Environment kinds" pre-selected, and a user expecting the pinned default
 * silently mints another kind-scoped key.
 *
 * Uses the REAL useBoolean (so the dialog actually opens/closes) and a Dialog
 * mock that exposes a close affordance. The kind chips ("Preview"/"Production")
 * render only while kindScoped, so their presence is the behavioral signal.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@mui/material", async () => {
  const actual = await vi.importActual<typeof import("@mui/material")>(
    "@mui/material",
  );
  return {
    ...actual,
    Dialog: ({ children, open, onClose }: any) =>
      open ? (
        <div data-testid="dialog">
          <button data-testid="__close" onClick={() => onClose?.()}>
            close
          </button>
          {children}
        </div>
      ) : null,
    DialogTitle: ({ children }: any) => <div>{children}</div>,
    DialogContent: ({ children }: any) => <div>{children}</div>,
    DialogActions: ({ children }: any) => <div>{children}</div>,
    Select: ({ children, value, onChange, ...props }: any) => (
      <select
        data-testid={props["data-testid"] || "select"}
        value={value}
        onChange={(e: any) => onChange?.({ target: { value: e.target.value } })}
      >
        {children}
      </select>
    ),
    MenuItem: ({ children, value }: any) => <option value={value}>{children}</option>,
  };
});

vi.mock("../actions", () => ({ createApiKeyAction: vi.fn() }));

vi.mock("@/lib/app-shell/app-context", () => ({
  useAppContext: () => ({ app: { id: "app-1", name: "Test App" } }),
}));

vi.mock("@/hooks/environments", () => ({
  useSelectedEnv: () => ({
    name: "dev",
    id: "env-default",
    isPinned: false,
    pinnedVersion: null,
    isDefault: true,
    isUnknown: false,
  }),
}));

vi.mock("@/components/hook-form", () => ({
  __esModule: true,
  default: ({ children, onSubmit }: any) => (
    <form onSubmit={onSubmit}>{children}</form>
  ),
  RHFTextField: ({ name, label }: any) => (
    <div>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} aria-label={label} />
    </div>
  ),
}));

vi.mock("@/components/upgrade-prompt", () => ({
  UpgradePrompt: ({ info }: any) => (
    <div data-testid="upgrade-prompt">{info?.message}</div>
  ),
}));

// Real stateful useBoolean so the dialog genuinely opens/closes across clicks.
vi.mock("@/hooks/use-boolean", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useBoolean: (initial = false) => {
      const [value, setValue] = React.useState(!!initial);
      return {
        value,
        onTrue: () => setValue(true),
        onFalse: () => setValue(false),
        onToggle: () => setValue((v: boolean) => !v),
        setValue,
      };
    },
  };
});

import { CreateApiKeyModal } from "./create-api-key-modal";

const openModal = () =>
  fireEvent.click(
    screen.getByRole("button", { name: /dashboard\.developers\.createButton/i }),
  );

describe("CreateApiKeyModal — env scope resets on reopen", () => {
  it("re-opening after choosing 'Environment kinds' returns to the pinned default", () => {
    render(<CreateApiKeyModal canCreateApiKey />);

    // First open: default scope → kind chips not shown.
    openModal();
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();

    // Switch to kind scope → kind chips appear.
    fireEvent.click(screen.getByText("Environment kinds"));
    expect(screen.getByText("Preview")).toBeInTheDocument();

    // Close, then reopen: must be back to the pinned default (no kind chips).
    fireEvent.click(screen.getByTestId("__close"));
    openModal();
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
  });
});
