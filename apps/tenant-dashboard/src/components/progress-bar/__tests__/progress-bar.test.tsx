// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-nprogress-bar", () => ({
  AppProgressBar: vi.fn(() => null),
}));

import { AppProgressBar } from "next-nprogress-bar";
import { createAppTheme } from "../../../theme/create-theme";
import ProgressBar from "../progress-bar";

const mockedBar = vi.mocked(AppProgressBar);

beforeEach(() => {
  mockedBar.mockClear();
});

describe("ProgressBar", () => {
  it("configures the nprogress bar with the brand-primary var and no spinner", () => {
    const theme = createAppTheme();
    render(
      <ThemeProvider theme={theme}>
        <ProgressBar />
      </ThemeProvider>,
    );

    expect(mockedBar).toHaveBeenCalledTimes(1);
    const props = mockedBar.mock.calls[0]![0];
    // Under a ThemeProvider MUI serves the var without its hex fallback (the
    // stylesheet supplies the value), so compare against the bare reference —
    // still exact enough to catch a swap to any other palette token.
    expect(props.color).toBe("var(--mui-palette-primary-main)");
    expect(props.height).toBe("2.5px");
    expect(props.options).toEqual({ showSpinner: false });
    expect(props.disableSameURL).toBe(true);
    expect(props.shallowRouting).toBe(true);
  });
});
