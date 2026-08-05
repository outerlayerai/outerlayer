// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { useSnackbar } from "notistack";
import { describe, expect, it } from "vitest";

// The real provider is imported by its concrete path so the global stub of the
// `@/components/snackbar` alias (test-helpers/unit-test-setup) does not intercept
// it — this exercises the actual notistack wrapper, not the passthrough mock.
import SnackbarProvider from "./snackbar-provider";

const theme = createTheme();

function Trigger({
  message,
  variant,
}: {
  message: string;
  variant: "success" | "error" | "warning" | "info";
}) {
  const { enqueueSnackbar } = useSnackbar();
  return (
    <button type="button" onClick={() => enqueueSnackbar(message, { variant })}>
      fire
    </button>
  );
}

function renderProvider(ui: React.ReactNode) {
  return render(
    <ThemeProvider theme={theme}>
      <SnackbarProvider>{ui}</SnackbarProvider>
    </ThemeProvider>,
  );
}

describe("SnackbarProvider", () => {
  it("mounts and renders its children without a SettingsProvider ancestor", () => {
    // The provider takes no settings-context dependency, so it stands up on
    // its own.
    renderProvider(<span>child-marker</span>);
    expect(screen.getByText("child-marker")).toBeInTheDocument();
  });

  it("enqueues a toast with the exact message under the requested variant", async () => {
    renderProvider(<Trigger message="Saved changes" variant="success" />);

    fireEvent.click(screen.getByRole("button", { name: "fire" }));

    const toast = await screen.findByText("Saved changes");
    expect(toast).toBeInTheDocument();
    // notistack tags the rendered content with the enqueued variant — proves the
    // Components map routed `success` through the styled content.
    expect(document.querySelector(".notistack-MuiContent-success")).not.toBeNull();
  });

  it("renders an optionless enqueue as a success toast (provider default)", async () => {
    function OptionlessTrigger() {
      const { enqueueSnackbar } = useSnackbar();
      return (
        <button type="button" onClick={() => enqueueSnackbar("Saved")}>
          fire
        </button>
      );
    }
    renderProvider(<OptionlessTrigger />);

    fireEvent.click(screen.getByRole("button", { name: "fire" }));

    await screen.findByText("Saved");
    // Live call sites enqueue with only a message and rely on this default —
    // it must resolve to the success variant, not notistack's inverted default.
    expect(document.querySelector(".notistack-MuiContent-success")).not.toBeNull();
    expect(document.querySelector(".notistack-MuiContent-default")).toBeNull();
  });

  it("dismisses a toast via the provider's close action", async () => {
    renderProvider(<Trigger message="Dismiss me" variant="error" />);

    fireEvent.click(screen.getByRole("button", { name: "fire" }));
    await screen.findByText("Dismiss me");

    fireEvent.click(
      screen.getByRole("button", { name: /dismiss notification/i }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Dismiss me")).not.toBeInTheDocument(),
    );
  });

  it("does not import the retired settings family (coupling broken)", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "snackbar-provider.tsx"),
      "utf8",
    );
    expect(source).not.toContain("@/components/settings");
    expect(source).not.toContain("useSettingsContext");
  });
});
