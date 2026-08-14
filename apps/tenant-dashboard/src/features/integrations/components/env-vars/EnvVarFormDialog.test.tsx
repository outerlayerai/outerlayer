// @vitest-environment jsdom
/**
 * Behaviour tests for <EnvVarFormDialog> — the target picker logic (kind
 * toggling + "All" exclusivity + the "Only <env>" override) and the save
 * contract `onSave(key, value, targets)`. Drives the dialog with fireEvent and
 * asserts the exact targets passed to onSave.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { EnvVarFormDialog } from "./EnvVarFormDialog";

function setup(
  props: Partial<React.ComponentProps<typeof EnvVarFormDialog>> = {},
) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <EnvVarFormDialog
      open
      onClose={onClose}
      onSave={onSave}
      showTargets
      currentEnvName="staging"
      {...props}
    />,
  );
  const inputs = document.querySelectorAll("input");
  return {
    onSave,
    onClose,
    keyInput: inputs[0] as HTMLInputElement,
    valueInput: inputs[1] as HTMLInputElement,
    save: () =>
      fireEvent.click(
        screen.getByText(/dashboard\.apps\.envVars\.addButton/i),
      ),
  };
}

function fill(keyInput: HTMLInputElement, valueInput: HTMLInputElement) {
  fireEvent.change(keyInput, { target: { value: "MY_KEY" } });
  fireEvent.change(valueInput, { target: { value: "the-value" } });
}

describe("EnvVarFormDialog — target picker", () => {
  it("defaults to the 'All Environments' target and saves it", async () => {
    const { onSave, keyInput, valueInput, save } = setup();
    fill(keyInput, valueInput);
    save();
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("MY_KEY", "the-value", ["all"]),
    );
  });

  it("selecting a kind clears 'All' (exclusivity) and saves that kind", async () => {
    const { onSave, keyInput, valueInput, save } = setup();
    fill(keyInput, valueInput);
    fireEvent.click(screen.getByText("Preview"));
    save();
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("MY_KEY", "the-value", ["preview"]),
    );
  });

  // proves AC-067-08
  it("selecting 'All Environments' clears the individual kinds", async () => {
    const { onSave, keyInput, valueInput, save } = setup();
    fill(keyInput, valueInput);
    fireEvent.click(screen.getByText("Development"));
    fireEvent.click(screen.getByText("Preview"));
    fireEvent.click(screen.getByText("All Environments"));
    save();
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("MY_KEY", "the-value", ["all"]),
    );
  });

  it("multi-selects kinds in display order", async () => {
    const { onSave, keyInput, valueInput, save } = setup();
    fill(keyInput, valueInput);
    fireEvent.click(screen.getByText("Preview"));
    fireEvent.click(screen.getByText("Development"));
    save();
    // toggleTarget order: preview added first, then development.
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("MY_KEY", "the-value", [
        "preview",
        "development",
      ]),
    );
  });

  it("selecting 'Only <env>' from the default clears 'All' (no stray all-row)", async () => {
    // Regression: 'all' is the default selection; clicking the specific-env
    // override must clear it. Otherwise the var is also written for every
    // environment (an 'all' row), leaking a single-env secret to production.
    const { onSave, keyInput, valueInput, save } = setup();
    fill(keyInput, valueInput);
    fireEvent.click(screen.getByText("Only staging"));
    save();
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("MY_KEY", "the-value", ["env"]),
    );
  });

  it("'Only <env>' coexists with an explicit kind (override model)", async () => {
    const { onSave, keyInput, valueInput, save } = setup();
    fill(keyInput, valueInput);
    fireEvent.click(screen.getByText("Preview")); // clears the default 'all'
    fireEvent.click(screen.getByText("Only staging"));
    save();
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("MY_KEY", "the-value", [
        "preview",
        "env",
      ]),
    );
  });

  it("selecting 'All Environments' clears a previously-set 'Only <env>'", async () => {
    const { onSave, keyInput, valueInput, save } = setup();
    fill(keyInput, valueInput);
    fireEvent.click(screen.getByText("Only staging"));
    fireEvent.click(screen.getByText("All Environments"));
    save();
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("MY_KEY", "the-value", ["all"]),
    );
  });

  // proves AC-067-09
  it("disables the Add button (not just no-ops) when the key is invalid", async () => {
    const { onSave, keyInput, valueInput } = setup();
    fireEvent.change(keyInput, { target: { value: "1BAD" } });
    fireEvent.change(valueInput, { target: { value: "v" } });
    const addButton = screen
      .getByText(/dashboard\.apps\.envVars\.addButton/i)
      .closest("button") as HTMLButtonElement;
    expect(addButton).toBeDisabled();
    fireEvent.click(addButton);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("hides the target picker in edit mode (value-only)", () => {
    setup({ showTargets: false, isEditing: true, initialKey: "EXISTING" });
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
    expect(screen.queryByText("All Environments")).not.toBeInTheDocument();
  });
});
