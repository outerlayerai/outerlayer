// @vitest-environment jsdom
/**
 * AppPolicyToggle — the generic per-app policy switch.
 *
 * Pins: toggling persists via the injected `save`, shows the saved toast, and
 * ends enabled; a rejection reverts the switch + surfaces the error; mid-flight
 * it's disabled with a spinner; no permission → disabled, never saves.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mui/material", () => ({
  Switch: ({ checked, disabled, onChange }: any) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange?.(e, e.target.checked)}
    />
  ),
  Tooltip: ({ children }: any) => <>{children}</>,
  Typography: ({ children }: any) => <span>{children}</span>,
  CircularProgress: () => <span role="progressbar" />,
}));
vi.mock("@mui/system", () => ({
  Stack: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@outerlayer/locales", () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));
const enqueueSnackbar = vi.fn();
vi.mock("notistack", () => ({ useSnackbar: () => ({ enqueueSnackbar }) }));

import { AppPolicyToggle } from "./app-policy-toggle";

const keys = {
  labelKey: "label",
  descriptionKey: "desc",
  savedKey: "saved",
  noPermissionKey: "noperm",
};
const sw = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("AppPolicyToggle", () => {
  beforeEach(() => {
    enqueueSnackbar.mockReset();
  });

  it("is enabled and idle (no spinner) before interaction when editable", () => {
    render(<AppPolicyToggle initialValue={false} canEdit save={vi.fn()} {...keys} />);
    expect(sw().disabled).toBe(false);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("persists via save and shows the saved toast, ending enabled", async () => {
    const save = vi.fn().mockResolvedValue({});
    render(<AppPolicyToggle initialValue={false} canEdit save={save} {...keys} />);

    fireEvent.click(sw());

    expect(save).toHaveBeenCalledWith(true);
    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith("saved", { variant: "success" })
    );
    expect(sw().checked).toBe(true);
    expect(sw().disabled).toBe(false);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("disables the switch and shows a spinner while the save is in flight", async () => {
    let resolve!: (v: { error?: string }) => void;
    const save = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(<AppPolicyToggle initialValue={false} canEdit save={save} {...keys} />);

    fireEvent.click(sw());

    await waitFor(() => expect(sw().disabled).toBe(true));
    expect(screen.queryByRole("progressbar")).not.toBeNull();

    resolve({});
    await waitFor(() => expect(sw().disabled).toBe(false));
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("reverts the switch and surfaces the error when save rejects", async () => {
    const save = vi.fn().mockResolvedValue({ error: "denied" });
    render(<AppPolicyToggle initialValue={false} canEdit save={save} {...keys} />);

    fireEvent.click(sw());

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith("denied", { variant: "error" })
    );
    expect(sw().checked).toBe(false);
  });

  it("disables the switch and never saves when not editable", () => {
    const save = vi.fn();
    render(<AppPolicyToggle initialValue canEdit={false} save={save} {...keys} />);
    expect(sw().disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});
