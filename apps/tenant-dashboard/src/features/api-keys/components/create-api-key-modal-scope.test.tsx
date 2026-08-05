// @vitest-environment jsdom
/**
 * Env-scope selector tests for <CreateApiKeyModal>. In "Environment kinds" mode
 * with no kind selected, Create must be disabled on EVERY role: if the
 * "select a kind" error renders only for the custom role, clicking Create on
 * the sdk/read-only roles is a silent no-op.
 *
 * Separate file so the dialog can be force-opened (useBoolean → value:true)
 * without affecting the sibling test that asserts the closed initial state.
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
    Dialog: ({ children, open }: any) =>
      open ? <div data-testid="dialog">{children}</div> : null,
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

const mockCreateApiKeyAction = vi.fn();
vi.mock("../actions", () => ({
  createApiKeyAction: (...args: any[]) => mockCreateApiKeyAction(...args),
}));

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

// Force the create dialog open so the env-scope selector renders.
vi.mock("@/hooks/use-boolean", () => ({
  useBoolean: () => ({
    value: true,
    onTrue: vi.fn(),
    onFalse: vi.fn(),
    onToggle: vi.fn(),
  }),
}));

import { CreateApiKeyModal } from "./create-api-key-modal";

const saveBtn = () =>
  screen.getByRole("button", { name: /dashboard\.developers\.saveButton/i });

describe("CreateApiKeyModal — environment scope", () => {
  it("renders the env-scope chips (pin vs kinds)", () => {
    render(<CreateApiKeyModal canCreateApiKey />);
    expect(screen.getByText("Environment kinds")).toBeInTheDocument();
    // default is pinned → Create is enabled (env resolves to env-default).
    expect(saveBtn()).not.toBeDisabled();
  });

  it("disables Create in kinds mode with no kind selected", () => {
    render(<CreateApiKeyModal canCreateApiKey />);
    fireEvent.click(screen.getByText("Environment kinds")); // kindScoped, default ['preview']
    expect(saveBtn()).not.toBeDisabled();
    fireEvent.click(screen.getByText("Preview")); // deselect → no kinds
    expect(saveBtn()).toBeDisabled();
  });

  it("re-enables Create once a kind is selected", () => {
    render(<CreateApiKeyModal canCreateApiKey />);
    fireEvent.click(screen.getByText("Environment kinds"));
    fireEvent.click(screen.getByText("Preview")); // off → disabled
    expect(saveBtn()).toBeDisabled();
    fireEvent.click(screen.getByText("Production")); // pick a kind → enabled
    expect(saveBtn()).not.toBeDisabled();
  });
});
