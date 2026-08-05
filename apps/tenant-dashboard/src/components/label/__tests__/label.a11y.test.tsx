// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { describe, it } from "vitest";

import { createAppTheme } from "../../../theme/create-theme";
import { expectNoA11yViolations } from "../../../test-helpers/a11y";
import Label from "../label";
import type { LabelColor } from "../types";

// Label paints text over a tinted/solid pill for every status surface in the
// product. The palette mapping is unit-tested in label.styles.test.ts; this
// baseline guards the rendered DOM contract — a status pill must carry no axe
// violations (contrast, role, name) in its default form or any filled color, so
// a future palette or markup change that breaks accessibility fails here.

const ALL_COLORS: readonly LabelColor[] = [
  "default",
  "primary",
  "secondary",
  "info",
  "success",
  "warning",
  "error",
];

function renderLabel(ui: React.ReactElement) {
  return render(<ThemeProvider theme={createAppTheme()}>{ui}</ThemeProvider>);
}

describe("Label — accessibility", () => {
  it("has no axe violations in its default state", async () => {
    const { container } = renderLabel(<Label>active</Label>);
    await expectNoA11yViolations(container);
  });

  it.each(ALL_COLORS)(
    "has no axe violations for the filled %s pill",
    async (color) => {
      const { container } = renderLabel(
        <Label color={color} variant="filled">
          {color}
        </Label>,
      );
      await expectNoA11yViolations(container);
    },
  );
});
