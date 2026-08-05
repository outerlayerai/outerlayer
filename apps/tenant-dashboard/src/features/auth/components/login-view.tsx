"use client";

import { buildLoginSchema } from "../schemas";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import Link from "@mui/material/Link";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import InputAdornment from "@mui/material/InputAdornment";

import { paths } from "@/routes/paths";
import { RouterLink } from "@/routes/components";

import { useBoolean } from "@/hooks/use-boolean";

import { useAuthContext } from "@/lib/adapters/use-auth-context";

import FormProvider, { RHFTextField } from "@/components/hook-form";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";

import { checkDomainSSO, validatePasswordLoginAllowed } from "@/utils/sso-actions";

// ----------------------------------------------------------------------

export default function SupabaseLoginView({
  loginWithGithub,
  loginWithGoogle,
  loginWithSSO,
  returnTo,
}: {
  loginWithGithub: (returnTo?: string | null) => Promise<void>;
  loginWithGoogle: (returnTo?: string | null) => Promise<void>;
  loginWithSSO?: (email: string, returnTo?: string | null) => Promise<void>;
  /**
   * Sanitized post-login destination. When set, the OAuth-callback chain
   * redirects to this path after the session is established (e.g. the
   * git-connect provider callback URL the user landed on while signed
   * out). When null, registered users land on `/orgs` per the existing
   * default.
   */
  returnTo?: string | null;
}) {
  const { login, logout } = useAuthContext();
  const { t } = useTranslate();

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [ssoCheck, setSsoCheck] = useState<{ hasSso: boolean; enforced: boolean } | null>(null);
  const [isCheckingSSO, setIsCheckingSSO] = useState(false);
  const lastCheckedDomainRef = useRef<string | null>(null);

  const password = useBoolean();

  const LoginSchema = buildLoginSchema(t, Boolean(ssoCheck?.enforced));

  const defaultValues = {
    email: "",
    password: "",
  };

  const methods = useForm({
    resolver: zodResolver(LoginSchema),
    defaultValues,
  });

  const emailValue = methods.watch("email");

  // Clear SSO check when the email domain changes significantly
  useEffect(() => {
    const domain = emailValue?.includes("@") ? emailValue.split("@")[1] : null;

    if (domain !== lastCheckedDomainRef.current) {
      setSsoCheck(null);
    }
  }, [emailValue]);

  const handleEmailBlur = useCallback(async () => {
    const email = methods.getValues("email");

    if (!email || !email.includes("@")) {
      return;
    }

    const domain = email.split("@")[1];

    if (!domain || domain === lastCheckedDomainRef.current) {
      return;
    }

    lastCheckedDomainRef.current = domain;
    setIsCheckingSSO(true);

    try {
      const result = await checkDomainSSO(email);
      if (result.error) {
        setErrorMsg("Unable to verify SSO status for your domain. Please try again.");
      }
      setSsoCheck({ hasSso: result.hasSso, enforced: result.enforced });
    } catch (err) {
      console.error("[SSO] Domain check failed:", err);
      setErrorMsg("Unable to verify SSO status. Please try again.");
      setSsoCheck(null);
    } finally {
      setIsCheckingSSO(false);
    }
  }, [methods]);

  useEffect(() => {
    logout();
  }, []);

  const { handleSubmit } = methods;

  const onSubmit = handleSubmit(async (data) => {
    if (ssoCheck?.enforced) {
      setErrorMsg("Your organization requires SSO login. Please use the \"Sign in with SSO\" button.");
      return;
    }

    try {
      setIsLoggingIn(true);
      setErrorMsg("");

      // Server-side enforcement check — guards against client-side bypass
      const { allowed, error: ssoError } = await validatePasswordLoginAllowed(data.email);
      if (!allowed) {
        setIsLoggingIn(false);
        setErrorMsg(ssoError ?? "Your organization requires SSO login.");
        return;
      }
      if (ssoError) {
        // Enforcement check failed — surface the warning to the user as the comment promises
        console.warn("[SSO] Enforcement check unavailable, proceeding with password login:", ssoError);
        setErrorMsg("Security check temporarily unavailable. Proceeding with login.");
      }

      await login?.(data.email, data.password ?? "");
      // Login succeeded. If the page was opened with `?return_to=<path>`,
      // honor it explicitly — GuestGuard's auth-state-driven redirect
      // doesn't read URL search params and would otherwise drop the user
      // on `/orgs/<org>/apps`, dropping the CLI handoff (or any other
      // setup-link flow that landed unauthenticated users here).
      //
      // `returnTo` is pre-sanitized by the server component before being
      // passed in (see `app/auth/login/page.tsx::sanitizeReturnTo`), so
      // hard-navigating to it is safe.
      if (returnTo) {
        // hard nav (not router.push) — bypasses GuestGuard's effect and
        // lets the destination page render with the fresh session.
        window.location.assign(returnTo);
        return;
      }
      // No return_to — GuestGuard will handle redirect once auth state updates
      // Don't reset isLoggingIn to avoid re-render that could interfere with navigation
    } catch (error: unknown) {
      setIsLoggingIn(false);
      console.error(error);

      const err = error as { message?: string; status?: number; code?: string };

      // Handle rate limiting specifically
      if (
        err?.message?.toLowerCase().includes("too many login attempts") ||
        err?.message?.toLowerCase().includes("rate limit") ||
        err?.message?.toLowerCase().includes("too many requests") ||
        err?.status === 429 ||
        err?.code === "RATE_LIMIT_EXCEEDED"
      ) {
        setErrorMsg(t("auth.login.rateLimitError"));
      } else {
        setErrorMsg(typeof error === "string" ? error : (err?.message ?? "Login failed. Please try again."));
      }
    }
  });

  const renderHead = (
    <Stack spacing={2} sx={{ mb: 5 }}>
      <Typography variant="h4">{t("auth.login.heading")}</Typography>

      <Stack direction="row" spacing={0.5}>
        <Typography variant="body2">{t("auth.login.newUser")}</Typography>

        <Link
          component={RouterLink}
          // Carry `return_to` through to the register page so a user who
          // arrived here for a CLI handoff / setup link and decides to
          // sign up still lands on the original destination after
          // registration completes. Register page reads the same param
          // and threads it through OAuth `redirectTo` → `/auth/callback`.
          href={
            returnTo
              ? `${paths.auth.register}?return_to=${encodeURIComponent(returnTo)}`
              : paths.auth.register
          }
          variant="subtitle2"
        >
          {t("auth.login.createAnAccountLink")}
        </Link>
      </Stack>
    </Stack>
  );

  const handleSSOLogin = useCallback(async () => {
    if (!loginWithSSO) return;
    setErrorMsg("");
    try {
      await loginWithSSO(methods.getValues("email"), returnTo);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "SSO login failed. Please try again.";
      setErrorMsg(message);
    }
  }, [loginWithSSO, methods, returnTo]);

  const renderSSOButton = ssoCheck?.hasSso && loginWithSSO ? (
    <Button
      fullWidth
      variant="outlined"
      size="large"
      loading={isCheckingSSO}
      startIcon={<Iconify icon="mdi:shield-key" />}
      onClick={handleSSOLogin}
    >
      Sign in with SSO
    </Button>
  ) : null;

  const renderForm = (
    <Stack spacing={2.5}>
      <div onBlur={handleEmailBlur}>
        <RHFTextField name="email" label={t("auth.login.emailPlaceholder")} />
      </div>

      {renderSSOButton}

      {!ssoCheck?.enforced && (
        <>
          <RHFTextField
            name="password"
            label={t("auth.login.passwordPlaceholder")}
            type={password.value ? "text" : "password"}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={password.onToggle} edge="end">
                      <Iconify
                        icon={
                          password.value ? "solar:eye-bold" : "solar:eye-closed-bold"
                        }
                      />
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <Link
            component={RouterLink}
            href={paths.auth.forgotPassword}
            variant="body2"
            color="inherit"
            underline="always"
            sx={{ alignSelf: "flex-end" }}
          >
            {t("auth.login.forgotPassword")}
          </Link>

          <Button
            fullWidth
            color="inherit"
            size="large"
            type="submit"
            variant="contained"
            loading={isLoggingIn}
          >
            {t("auth.login.loginButton")}
          </Button>
        </>
      )}
    </Stack>
  );

  const renderOAuth = (
    <>
      <Stack
        spacing={2}
        sx={{
          mt: 2,
          justifyContent: "center",
          alignItems: "center",
          color: "text.secondary"
        }}>
        <Typography variant="body2">{t("auth.login.or")}</Typography>
        <Button
          fullWidth
          variant="outlined"
          onClick={() => {
            if (ssoCheck?.enforced) {
              setErrorMsg("Your organization requires SSO login. Please use the \"Sign in with SSO\" button.");
              return;
            }
            loginWithGoogle(returnTo);
          }}
          size="large"
          startIcon={<Iconify icon="mdi:google" />}
        >
          {t("auth.login.loginWithGoogle")}
        </Button>
        <Button
          fullWidth
          variant="outlined"
          onClick={() => {
            if (ssoCheck?.enforced) {
              setErrorMsg("Your organization requires SSO login. Please use the \"Sign in with SSO\" button.");
              return;
            }
            loginWithGithub(returnTo);
          }}
          size="large"
          startIcon={<Iconify icon="mdi:github" />}
        >
          {t("auth.login.loginWithGitHub")}
        </Button>
      </Stack>
    </>
  );

  return (
    <>
      {renderHead}

      {!!errorMsg && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {errorMsg}
        </Alert>
      )}

      <FormProvider methods={methods} onSubmit={onSubmit}>
        {renderForm}
      </FormProvider>

      {!ssoCheck?.enforced && renderOAuth}
    </>
  );
}
