"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";

import { useTranslate } from "@outerlayer/locales";
import { paths } from "@/routes/paths";
import { RouterLink } from "@/routes/components";
import {
  acceptInvitationAction,
  declineInvitationAction,
  getInvitationDetailsAction,
  checkTermsForInvitationAction,
} from "../action-adapters";
import Iconify from "@/components/iconify";
import { TermsCheckboxField } from "@/components/terms-checkbox";
import { createSupabaseFontendClient } from "@/lib/adapters/supabase-frontend-client";

type InvitationState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "expired"; companyName: string }
  | { status: "ready"; id: string; companyName: string; organizationName: string }
  | { status: "accepting" }
  | { status: "success"; companyName: string }
  | { status: "already_accepted" }
  | { status: "org_limit_reached"; companyName: string };

export default function AcceptInviteView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslate();
  const membershipId = searchParams.get("id");

  const [state, setState] = useState<InvitationState>({ status: "loading" });
  const [needsTermsAgreement, setNeedsTermsAgreement] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [isDeclining, setIsDeclining] = useState(false);

  const loadInvitation = useCallback(async () => {
    if (!membershipId) {
      setState({ status: "error", message: t("auth.acceptInvite.error.invalidLink") });
      return;
    }

    const result = await getInvitationDetailsAction(membershipId);

    if (result.error) {
      if (result.error === "already_accepted") {
        setState({ status: "already_accepted" });
      } else {
        setState({ status: "error", message: result.error });
      }
      return;
    }

    if (result.data?.isExpired) {
      setState({ status: "expired", companyName: result.data.companyName });
      return;
    }

    if (result.data) {
      setState({
        status: "ready",
        id: result.data.id,
        companyName: result.data.companyName,
        organizationName: result.data.organizationName,
      });

      // Check if user needs to agree to terms
      const termsCheck = await checkTermsForInvitationAction();
      if (termsCheck.data?.needsAgreement) {
        setNeedsTermsAgreement(true);
      }
    }
  }, [membershipId, t]);

  useEffect(() => {
    loadInvitation();
  }, [loadInvitation]);

  const handleAccept = async () => {
    if (state.status !== "ready") return;

    // If terms agreement is needed, validate checkbox
    if (needsTermsAgreement && !agreedToTerms) {
      setTermsError("You must agree to the Terms of Service and Privacy Policy to continue");
      return;
    }

    setTermsError(null);
    setState({ status: "accepting" });

    // Pass agreedToTerms flag to accept invitation (it will record the agreement)
    const result = await acceptInvitationAction(state.id, needsTermsAgreement && agreedToTerms);

    if (result.error) {
      if (result.error === "expired") {
        setState({ status: "expired", companyName: state.companyName });
      } else if (result.error.includes("maximum of 10 organizations")) {
        setState({ status: "org_limit_reached", companyName: state.companyName });
      } else {
        setState({ status: "error", message: result.error });
      }
      return;
    }

    if (result.data) {
      // Refresh session to update memberships in AuthContext
      const supabase = createSupabaseFontendClient();
      await supabase.auth.refreshSession();

      setState({ status: "success", companyName: result.data.companyName });
    }
  };

  const handleDecline = async () => {
    if (state.status !== "ready") return;

    setIsDeclining(true);
    const result = await declineInvitationAction(state.id);

    if (result.error) {
      setIsDeclining(false);
      setState({ status: "error", message: result.error });
      return;
    }

    // Same destination the button navigated to before it dispatched a
    // server action: the invite is gone, nothing left on this page to act on.
    router.push(paths.dashboard.root);
  };

  // Loading state
  if (state.status === "loading") {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 300 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Error state
  if (state.status === "error") {
    return (
      <Stack spacing={3} sx={{
        alignItems: "center"
      }}>
        <Typography variant="h4">{t("auth.acceptInvite.error.title")}</Typography>
        <Alert severity="error" sx={{ width: "100%" }}>
          {state.message}
        </Alert>
        <Button
          component={RouterLink}
          href={paths.dashboard.root}
          size="large"
          color="inherit"
          variant="contained"
          startIcon={<Iconify icon="eva:arrow-ios-back-fill" />}
        >
          {t("auth.acceptInvite.error.goToDashboard")}
        </Button>
      </Stack>
    );
  }

  // Expired state
  if (state.status === "expired") {
    return (
      <Stack spacing={3} sx={{
        alignItems: "center"
      }}>
        <Typography variant="h4">{t("auth.acceptInvite.expired.title")}</Typography>
        <Alert severity="warning" sx={{ width: "100%" }}>
          {t("auth.acceptInvite.expired.message", { companyName: state.companyName })}
        </Alert>
        <Button
          component={RouterLink}
          href={paths.dashboard.root}
          size="large"
          color="inherit"
          variant="contained"
          startIcon={<Iconify icon="eva:arrow-ios-back-fill" />}
        >
          {t("auth.acceptInvite.error.goToDashboard")}
        </Button>
      </Stack>
    );
  }

  // Already accepted state
  if (state.status === "already_accepted") {
    return (
      <Stack spacing={3} sx={{
        alignItems: "center"
      }}>
        <Typography variant="h4">{t("auth.acceptInvite.alreadyAccepted.title")}</Typography>
        <Alert severity="info" sx={{ width: "100%" }}>
          {t("auth.acceptInvite.alreadyAccepted.message")}
        </Alert>
        <Button
          component={RouterLink}
          href={paths.dashboard.root}
          size="large"
          color="inherit"
          variant="contained"
          startIcon={<Iconify icon="eva:arrow-ios-back-fill" />}
        >
          {t("auth.acceptInvite.error.goToDashboard")}
        </Button>
      </Stack>
    );
  }

  // Org limit reached state
  if (state.status === "org_limit_reached") {
    return (
      <Stack spacing={3} sx={{
        alignItems: "center"
      }}>
        <Typography variant="h4">{t("auth.acceptInvite.orgLimitReached.title")}</Typography>
        <Alert severity="warning" sx={{ width: "100%" }}>
          {t("auth.acceptInvite.orgLimitReached.message", { companyName: state.companyName })}
        </Alert>
        <Button
          component={RouterLink}
          href={paths.dashboard.root}
          size="large"
          color="inherit"
          variant="contained"
          startIcon={<Iconify icon="eva:arrow-ios-back-fill" />}
        >
          {t("auth.acceptInvite.error.goToDashboard")}
        </Button>
      </Stack>
    );
  }

  // Accepting state
  if (state.status === "accepting") {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minHeight: 300 }}>
        <CircularProgress />
        <Typography>{t("auth.acceptInvite.accepting")}</Typography>
      </Box>
    );
  }

  // Success state
  if (state.status === "success") {
    return (
      <Stack spacing={3} sx={{
        alignItems: "center"
      }}>
        <Typography variant="h4">{t("auth.acceptInvite.success.title")}</Typography>
        <Alert severity="success" sx={{ width: "100%" }}>
          {t("auth.acceptInvite.success.message", { companyName: state.companyName })}
        </Alert>
        <Button
          component={RouterLink}
          href={paths.dashboard.root}
          size="large"
          color="inherit"
          variant="contained"
          startIcon={<Iconify icon="eva:arrow-ios-back-fill" />}
        >
          {t("auth.acceptInvite.error.goToDashboard")}
        </Button>
      </Stack>
    );
  }

  // Ready state - show accept button
  return (
    <Stack spacing={3} sx={{
      alignItems: "center"
    }}>
      <Typography variant="h4">{t("auth.acceptInvite.title")}</Typography>
      <Typography variant="body1" sx={{ textAlign: "center" }}>
        {t("auth.acceptInvite.invitedTo")} <strong>{state.companyName}</strong>.
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          textAlign: "center"
        }}>
        {t("auth.acceptInvite.description")}
      </Typography>
      {/* Terms Agreement Section - shown when user hasn't agreed to current version */}
      {needsTermsAgreement && (
        <Box
          sx={{
            bgcolor: "background.neutral",
            borderRadius: 1,
            p: 2,
            width: "100%",
          }}
        >
          <TermsCheckboxField
            checked={agreedToTerms}
            onChange={(checked) => {
              setAgreedToTerms(checked);
              if (checked) setTermsError(null);
            }}
            error={termsError}
          />
        </Box>
      )}
      <Stack direction="row" spacing={2}>
        <Button
          variant="outlined"
          onClick={handleDecline}
          loading={isDeclining}
        >
          {t("auth.acceptInvite.declineButton")}
        </Button>
        <Button
          variant="contained"
          color="inherit"
          size="large"
          onClick={handleAccept}
          disabled={needsTermsAgreement && !agreedToTerms}
        >
          {t("auth.acceptInvite.acceptButton")}
        </Button>
      </Stack>
    </Stack>
  );
}
