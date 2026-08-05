// @vitest-environment jsdom
/**
 * AiCostForm component tests. `updateAiCostConfigAction` returns a typed
 * `ActionResult`, and these tests pin that a failure surfaces inline — a
 * denied write must never render the success toast — and that client-side
 * validation blocks a bad submission before the action is ever called.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ControllerRenderProps } from "react-hook-form";

vi.mock("@mui/material/TextField", () => ({
  __esModule: true,
  default: ({ label, ...rest }: any) => <input aria-label={label} {...rest} />,
}));

vi.mock("@mui/system", () => ({
  Box: ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
  Stack: ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
}));

vi.mock("@/components/settings-shell", () => ({
  SettingsSection: ({ children, footer }: any) => (
    <div>
      <div data-testid="section-body">{children}</div>
      {footer && <div data-testid="section-footer">{footer.action}</div>}
    </div>
  ),
}));

vi.mock("@outerlayer/locales", () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

const { enqueueSnackbarMock } = vi.hoisted(() => ({ enqueueSnackbarMock: vi.fn() }));
vi.mock("notistack", () => ({
  useSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock }),
}));

vi.mock("@/components/hook-form", () => {
  const { Controller, useFormContext, FormProvider: RHFFormProvider } = require("react-hook-form");
  return {
    __esModule: true,
    default: ({ children, methods, onSubmit }: any) => (
      <RHFFormProvider {...methods}>
        <form onSubmit={onSubmit}>{children}</form>
      </RHFFormProvider>
    ),
    RHFTextField: ({ name, label }: any) => {
      const { control } = useFormContext();
      return (
        <Controller
          name={name}
          control={control}
          render={({ field, fieldState: { error } }: { field: ControllerRenderProps; fieldState: any }) => (
            <>
              <input {...field} value={field.value ?? ""} aria-label={label} />
              {error && <span role="alert">{error.message}</span>}
            </>
          )}
        />
      );
    },
  };
});

type ActionResult = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

const { mockUpdateAiCostConfig } = vi.hoisted(() => ({
  mockUpdateAiCostConfig: vi.fn<(...args: unknown[]) => Promise<ActionResult>>(async () => ({
    ok: true,
    data: undefined,
  })),
}));
vi.mock("../../actions", () => ({
  updateAiCostConfigAction: (...args: unknown[]) => mockUpdateAiCostConfig(...args),
}));

import { AiCostForm } from "../ai-cost-form";

function getSeatCountField() {
  return screen.getByLabelText("dashboard.settings.aiCost.form.seatCountLabel");
}

function getCostPerSeatField() {
  return screen.getByLabelText("dashboard.settings.aiCost.form.costPerSeatLabel");
}

function getSaveButton() {
  return screen.getByRole("button", { name: /dashboard.settings.aiCost.form.saveButton/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateAiCostConfig.mockResolvedValue({ ok: true, data: { seatCount: 5, costPerSeatUsd: 20 } });
});

it("renders the RSC-seeded config and computes the monthly total exactly", () => {
  render(<AiCostForm initial={{ seatCount: 12, costPerSeatUsd: 30 }} />);
  expect(getSeatCountField()).toHaveValue("12");
  expect(getCostPerSeatField()).toHaveValue("30");
  // fCurrency strips a whole-number's trailing ".00" (see format-number.ts).
  expect(screen.getByText("$360")).toBeInTheDocument();
});

it("renders zeros with no error when initial is null (never configured or read denied)", () => {
  render(<AiCostForm initial={null} />);
  expect(getSeatCountField()).toHaveValue("0");
  expect(getCostPerSeatField()).toHaveValue("0");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("submits the edited values and shows the success toast on a typed ok result", async () => {
  render(<AiCostForm initial={{ seatCount: 12, costPerSeatUsd: 30 }} />);

  await userEvent.clear(getSeatCountField());
  await userEvent.type(getSeatCountField(), "5");
  await userEvent.clear(getCostPerSeatField());
  await userEvent.type(getCostPerSeatField(), "20");
  await userEvent.click(getSaveButton());

  await waitFor(() => {
    expect(mockUpdateAiCostConfig).toHaveBeenCalledWith({ seatCount: 5, costPerSeatUsd: 20 });
  });
  expect(enqueueSnackbarMock).toHaveBeenCalledWith(
    "dashboard.settings.aiCost.form.successNotification",
    { variant: "success" },
  );
});

it("surfaces a typed denial inline and skips the success toast", async () => {
  mockUpdateAiCostConfig.mockResolvedValue({
    ok: false,
    error: { code: "forbidden", message: "Permission denied: ai_cost_config.update" },
  });
  render(<AiCostForm initial={{ seatCount: 12, costPerSeatUsd: 30 }} />);

  await userEvent.click(getSaveButton());

  await waitFor(() => {
    expect(screen.getByRole("alert")).toHaveTextContent("Permission denied: ai_cost_config.update");
  });
  expect(enqueueSnackbarMock).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ variant: "success" }),
  );
  expect(enqueueSnackbarMock).toHaveBeenCalledWith(
    "Permission denied: ai_cost_config.update",
    { variant: "error" },
  );
});

it("blocks submission on a negative seat count with the existing message and never calls the action", async () => {
  render(<AiCostForm initial={{ seatCount: 12, costPerSeatUsd: 30 }} />);

  await userEvent.clear(getSeatCountField());
  await userEvent.type(getSeatCountField(), "-3");
  await userEvent.click(getSaveButton());

  await waitFor(() => {
    expect(screen.getByText("dashboard.settings.aiCost.form.numberNegative")).toBeInTheDocument();
  });
  expect(mockUpdateAiCostConfig).not.toHaveBeenCalled();
});

it("blocks submission on a non-integer seat count with the existing message and never calls the action", async () => {
  render(<AiCostForm initial={{ seatCount: 12, costPerSeatUsd: 30 }} />);

  await userEvent.clear(getSeatCountField());
  await userEvent.type(getSeatCountField(), "2.5");
  await userEvent.click(getSaveButton());

  await waitFor(() => {
    expect(screen.getByText("dashboard.settings.aiCost.form.numberInvalid")).toBeInTheDocument();
  });
  expect(mockUpdateAiCostConfig).not.toHaveBeenCalled();
});

it("imports neither the browser Supabase client nor the auth context — no client-tier data access", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const text = await fs.readFile(path.resolve(__dirname, "../ai-cost-form.tsx"), "utf8");
  expect(text).not.toContain("createSupabaseFontendClient");
  expect(text).not.toContain("useAuthContext");
});
