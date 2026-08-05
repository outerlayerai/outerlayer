"use client";

import React, { useState } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import Alert from "@mui/material/Alert";

// Environment variables with defaults
const TERMS_URL =
  process.env.NEXT_PUBLIC_TERMS_URL || "https://www.agentmark.co/terms";
const PRIVACY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_URL || "https://www.agentmark.co/privacy";

// ----------------------------------------------------------------------

interface TermsAgreementViewProps {
  /** Server action to call when user agrees */
  onAgree: () => Promise<{ error?: string } | void>;
  /** Whether this is a pending OAuth registration flow */
  isPending?: boolean;
  /** Whether this is a blocking flow for existing users */
  isBlocking?: boolean;
  /** URL to return to after agreement */
  returnTo?: string;
}

/**
 * Full-page terms agreement view for OAuth registration and blocking flows.
 * Users must explicitly check a checkbox and click agree to proceed.
 */
export default function TermsAgreementView({
  onAgree,
  isPending = false,
  isBlocking = false,
}: TermsAgreementViewProps) {
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAgree = async () => {
    if (!agreed) {
      setError("You must agree to the Terms of Service and Privacy Policy to continue");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const result = await onAgree();
      if (result?.error) {
        setError(result.error);
        setIsSubmitting(false);
      }
      // If successful, the server action will redirect
    } catch (_err) {
      setError("An error occurred. Please try again.");
      setIsSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        p: 3,
      }}
    >
      <Card
        sx={{
          maxWidth: 480,
          width: "100%",
          p: 4,
        }}
      >
        <Stack spacing={3}>
          <Typography variant="h4" align="center">
            {isBlocking ? "Terms Update Required" : "Almost There!"}
          </Typography>

          <Typography variant="body1" align="center" sx={{
            color: "text.secondary"
          }}>
            {isBlocking
              ? "Our Terms of Service have been updated. Please review and agree to continue using the platform."
              : isPending
                ? "Before we complete your account setup, please review and agree to our Terms of Service and Privacy Policy."
                : "Please review and agree to our Terms of Service and Privacy Policy to continue."}
          </Typography>

          {error && (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Box
            sx={{
              bgcolor: "background.neutral",
              borderRadius: 1,
              p: 2,
            }}
          >
            <FormControlLabel
              control={
                <Checkbox
                  checked={agreed}
                  onChange={(e) => {
                    setAgreed(e.target.checked);
                    if (e.target.checked) setError(null);
                  }}
                  className={!agreed && error ? "Mui-error" : undefined}
                  slotProps={{
                    input: {
                      "aria-invalid": !agreed && error ? true : undefined,
                    },
                  }}
                  data-testid="terms-agreement-checkbox"
                />
              }
              label={
                <Typography variant="body2">
                  I have read and agree to the{" "}
                  <Link
                    href={TERMS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    underline="always"
                    data-testid="terms-link"
                  >
                    Terms of Service
                  </Link>{" "}
                  and{" "}
                  <Link
                    href={PRIVACY_URL}
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

            {!agreed && error && (
              <FormHelperText error sx={{ ml: 4 }}>
                You must agree to continue
              </FormHelperText>
            )}
          </Box>

          <Button
            fullWidth
            size="large"
            variant="contained"
            onClick={handleAgree}
            loading={isSubmitting}
            disabled={!agreed}
            data-testid="agree-button"
          >
            {isBlocking ? "I Agree - Continue" : "I Agree - Complete Setup"}
          </Button>

          {isBlocking && (
            <Typography variant="caption" align="center" sx={{
              color: "text.secondary"
            }}>
              You cannot use the platform until you agree to the updated terms.
            </Typography>
          )}
        </Stack>
      </Card>
    </Box>
  );
}
