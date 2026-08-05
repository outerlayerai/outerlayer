"use client";

import { useEffect } from "react";
import ProfileForm from "./profile-form";
import { useSnackbar } from '@/components/snackbar';
import { useTranslate } from "@outerlayer/locales";

// ----------------------------------------------------------------------

type ProfileSettingsProps = {
  emailChangeStatus?: string;
  emailChangeError?: string;
};

const getTranslations = (key: string) => {
  return `dashboard.profileSettings.${key}`;
};

/**
 * The General tab of /profile: the profile form plus the email-change callback
 * handling (only this route carries the `email_change` / `email_error` query
 * params). Connections and Security live on their own sub-routes; the page
 * heading and left nav come from the profile SettingsShell layout.
 */
export default function ProfileSettings({
  emailChangeStatus,
  emailChangeError,
}: ProfileSettingsProps) {
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslate();

  // Handle email change callback results
  useEffect(() => {
    if (!emailChangeStatus) return;

    if (emailChangeStatus === "success") {
      enqueueSnackbar(t(getTranslations("emailChangeVerified")), {
        variant: "success",
        autoHideDuration: 8000,
      });
    } else if (emailChangeStatus === "error") {
      let errorKey = "emailChangeErrors.unknown";
      if (emailChangeError === "expired") {
        errorKey = "emailChangeErrors.expired";
      } else if (emailChangeError === "already_used") {
        errorKey = "emailChangeErrors.alreadyUsed";
      }
      enqueueSnackbar(t(getTranslations(errorKey)), {
        variant: "error",
        autoHideDuration: 8000,
      });
    }

    // Clean up URL params after showing notification
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("email_change");
      url.searchParams.delete("email_error");
      window.history.replaceState({}, "", url.toString());
    }
  }, [emailChangeStatus, emailChangeError, enqueueSnackbar, t]);

  return <ProfileForm />;
}
