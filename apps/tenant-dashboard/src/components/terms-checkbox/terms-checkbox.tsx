"use client";

import React from "react";
import { Controller, useFormContext } from "react-hook-form";
import TermsCheckboxField from "./terms-checkbox-field";

// ----------------------------------------------------------------------

interface TermsCheckboxProps {
  /** Form field name (default: "agreedToTerms") */
  name?: string;
  /** Custom terms URL (overrides env var) */
  termsUrl?: string;
  /** Custom privacy URL (overrides env var) */
  privacyUrl?: string;
}

/**
 * Terms agreement checkbox with links to Terms of Service and Privacy Policy,
 * wired to a `react-hook-form` field.
 *
 * Usage:
 * ```tsx
 * <FormProvider methods={methods} onSubmit={onSubmit}>
 *   <TermsCheckbox />
 * </FormProvider>
 * ```
 */
export default function TermsCheckbox({
  name = "agreedToTerms",
  termsUrl,
  privacyUrl,
}: TermsCheckboxProps) {
  const { control } = useFormContext();

  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState: { error } }) => (
        <TermsCheckboxField
          checked={field.value || false}
          onChange={field.onChange}
          onBlur={field.onBlur}
          name={field.name}
          inputRef={field.ref}
          error={error ? error.message || "You must agree to the terms to continue" : null}
          termsUrl={termsUrl}
          privacyUrl={privacyUrl}
        />
      )}
    />
  );
}
