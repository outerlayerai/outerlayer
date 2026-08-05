// @vitest-environment jsdom
/**
 * Tests for <NavRail>'s collapse control.
 *
 * One component owns both the vertical and mini variants, with a
 * footer toggle control. These pins lock the
 * per-layout contract: which section variant renders, the control's aria-label
 * and label, and — the mutation the toggle is most likely to get wrong — that
 * clicking persists the OPPOSITE layout under the exact settings key.
 *
 * Boundaries: the nav-section family, nav data, and the responsive hook are
 * stubbed — only the rail's own toggle wiring is under test.
 * `useResponsive` is forced true so the desktop footer (the only place the
 * control lives) renders; jsdom can't evaluate the real breakpoint.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("@/components/nav-section", () => ({
  NavSectionVertical: () => <div data-testid="nav-vertical" />,
  NavSectionMini: () => <div data-testid="nav-mini" />,
}));
vi.mock("@/components/logo", () => ({
  __esModule: true,
  default: ({ full }: { full?: boolean }) => (
    <div data-testid={full ? "wordmark" : "mark"} />
  ),
}));
vi.mock("../config-navigation", () => ({ useNavData: () => [] }));
vi.mock("../../../hooks/use-responsive", () => ({ useResponsive: () => true }));
vi.mock("@/components/settings", () => ({
  useSettingsContext: vi.fn(),
}));

import { useSettingsContext } from "@/components/settings";
import NavRail from "../nav-rail";

const onUpdate = vi.fn();

function setLayout(themeLayout: "vertical" | "mini") {
  vi.mocked(useSettingsContext).mockReturnValue({
    themeLayout,
    onUpdate,
  } as unknown as ReturnType<typeof useSettingsContext>);
}

function renderRail() {
  return render(
    <ThemeProvider theme={createTheme()}>
      <NavRail openNav={false} onCloseNav={vi.fn()} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  onUpdate.mockClear();
});

describe("NavRail — collapse control", () => {
  it("vertical: shows the labelled Collapse control over the vertical section and collapses to mini on click", async () => {
    setLayout("vertical");
    renderRail();

    expect(screen.getByTestId("nav-vertical")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-mini")).not.toBeInTheDocument();
    // Expanded rail carries the full wordmark at its top-left, not the mark.
    expect(screen.getByTestId("wordmark")).toBeInTheDocument();
    expect(screen.queryByTestId("mark")).not.toBeInTheDocument();

    const control = screen.getByRole("button", { name: "Collapse navigation" });
    expect(control).toHaveTextContent("Collapse");

    await userEvent.click(control);
    expect(onUpdate).toHaveBeenCalledWith("themeLayout", "mini");
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("mini: shows the Expand control over the mini section and expands to vertical on click", async () => {
    setLayout("mini");
    renderRail();

    expect(screen.getByTestId("nav-mini")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-vertical")).not.toBeInTheDocument();
    // Mini rail collapses the logo to the square mark, not the wordmark.
    expect(screen.getByTestId("mark")).toBeInTheDocument();
    expect(screen.queryByTestId("wordmark")).not.toBeInTheDocument();

    const control = screen.getByRole("button", { name: "Expand navigation" });

    await userEvent.click(control);
    expect(onUpdate).toHaveBeenCalledWith("themeLayout", "vertical");
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
