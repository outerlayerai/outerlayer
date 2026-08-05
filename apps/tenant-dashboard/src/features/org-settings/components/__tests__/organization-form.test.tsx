// @vitest-environment jsdom
/**
 * OrganizationForm component tests. `updateOrganizationAction` returns a
 * typed `ActionResult`, and these tests pin that a failure surfaces inline
 * — an RLS-denied write must never render the success toast.
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
    RHFTextField: ({ name, label, disabled }: any) => {
      const { control } = useFormContext();
      return (
        <Controller
          name={name}
          control={control}
          render={({ field, fieldState: { error } }: { field: ControllerRenderProps; fieldState: any }) => (
            <>
              <input {...field} value={field.value ?? ""} aria-label={label} disabled={disabled} />
              {error && <span role="alert">{error.message}</span>}
            </>
          )}
        />
      );
    },
  };
});

type ActionResult = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

const { mockUpdateOrganization } = vi.hoisted(() => ({
  mockUpdateOrganization: vi.fn<(...args: unknown[]) => Promise<ActionResult>>(async () => ({
    ok: true,
    data: undefined,
  })),
}));
vi.mock("../../actions", () => ({
  updateOrganizationAction: (...args: unknown[]) => mockUpdateOrganization(...args),
}));

import { OrganizationForm } from "../organization-form";

const ORG = { tenantId: "tenant-1", companyName: "Old Name" };

function getNameField() {
  return screen.getByLabelText("dashboard.settings.organization.form.companyNamePlaceholder");
}

function getSaveButton() {
  return screen.getByRole("button", { name: /dashboard.settings.organization.form.saveButton/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateOrganization.mockResolvedValue({ ok: true, data: { tenantId: "tenant-1", companyName: "New Name" } });
});

it("seeds the form from the RSC-read org row, no client fetch", () => {
  render(<OrganizationForm org={ORG} />);
  expect(getNameField()).toHaveValue("Old Name");
});

it("submits the edited name and shows the success toast on a typed ok result", async () => {
  render(<OrganizationForm org={ORG} />);

  await userEvent.clear(getNameField());
  await userEvent.type(getNameField(), "New Name");
  await userEvent.click(getSaveButton());

  await waitFor(() => {
    expect(mockUpdateOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ companyName: "New Name" }),
    );
  });
  expect(enqueueSnackbarMock).toHaveBeenCalledWith(
    "dashboard.settings.organization.form.successNotification",
    { variant: "success" },
  );
});

it("surfaces a typed failure inline and skips the success toast", async () => {
  mockUpdateOrganization.mockResolvedValue({
    ok: false,
    error: { code: "forbidden", message: "Permission denied: tenant.update" },
  });
  render(<OrganizationForm org={ORG} />);

  await userEvent.click(getSaveButton());

  await waitFor(() => {
    expect(screen.getByRole("alert")).toHaveTextContent("Permission denied: tenant.update");
  });
  expect(enqueueSnackbarMock).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ variant: "success" }),
  );
  expect(enqueueSnackbarMock).toHaveBeenCalledWith(
    "Permission denied: tenant.update",
    { variant: "error" },
  );
});

it("shows an error snackbar when updateOrganizationAction rejects at the transport level", async () => {
  // The exact rejection Next.js throws for a non-Flight server-action
  // response (deployment skew, a mangled proxy response) — the awaited call
  // throws instead of resolving, bypassing the `result.ok` branch entirely.
  mockUpdateOrganization.mockRejectedValue(
    new Error("An unexpected response was received from the server."),
  );
  render(<OrganizationForm org={ORG} />);

  await userEvent.click(getSaveButton());

  await waitFor(() => {
    expect(enqueueSnackbarMock).toHaveBeenCalledWith(
      "dashboard.settings.organization.form.errorNotification",
      { variant: "error" },
    );
  });
});

it("renders the org id read-only", () => {
  render(<OrganizationForm org={ORG} />);
  expect(
    screen.getByLabelText("dashboard.settings.organization.form.organizationIdPlaceholder"),
  ).toBeDisabled();
});
