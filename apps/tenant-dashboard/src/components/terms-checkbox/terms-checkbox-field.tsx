"use client";

import { Ref } from "react";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";

// Environment variables with defaults
const TERMS_URL =
  process.env.NEXT_PUBLIC_TERMS_URL || "https://www.agentmark.co/terms";
const PRIVACY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_URL || "https://www.agentmark.co/privacy";

interface TermsCheckboxFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Shown as a validation error and toggles the checkbox's error styling. */
  error?: string | null;
  /** Custom terms URL (overrides env var) */
  termsUrl?: string;
  /** Custom privacy URL (overrides env var) */
  privacyUrl?: string;
  /**
   * `react-hook-form`'s field bindings — optional because the plain
   * `useState`-driven caller (the invite-acceptance flow) has no form to
   * report blur/name/ref back to. `onBlur` drives touched-state tracking;
   * `inputRef` is what `shouldFocusError` needs to focus this field after a
   * failed submit.
   */
  onBlur?: () => void;
  name?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * The terms-agreement checkbox markup and copy — links to Terms of Service
 * and Privacy Policy, checkbox + error state. Presentational: callers own
 * how the checked/error state is managed (`react-hook-form` via
 * `TermsCheckbox`, or plain `useState` for a flow with no surrounding form).
 */
export default function TermsCheckboxField({
  checked,
  onChange,
  error,
  termsUrl = TERMS_URL,
  privacyUrl = PRIVACY_URL,
  onBlur,
  name,
  inputRef,
}: TermsCheckboxFieldProps) {
  return (
    <Box>
      <FormControlLabel
        control={
          <Checkbox
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            onBlur={onBlur}
            name={name}
            className={error ? "Mui-error" : undefined}
            // MUI's Checkbox has no `inputRef` prop (that's a pre-v6 API) —
            // the input slot's ref is how a caller reaches the native
            // `<input>` node in the current slot API.
            slotProps={{ input: { "aria-invalid": error ? true : undefined, ref: inputRef } }}
            data-testid="terms-checkbox"
          />
        }
        label={
          <Typography variant="body2" component="span">
            I agree to the{" "}
            <Link
              href={termsUrl}
              target="_blank"
              rel="noopener noreferrer"
              underline="always"
              data-testid="terms-link"
            >
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              href={privacyUrl}
              target="_blank"
              rel="noopener noreferrer"
              underline="always"
              data-testid="privacy-link"
            >
              Privacy Policy
            </Link>
          </Typography>
        }
      />

      {error && (
        <FormHelperText error sx={{ ml: 4 }}>
          {error}
        </FormHelperText>
      )}
    </Box>
  );
}
