import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../supabaseServerClient";
import { createSupabaseAdminClient } from "../../../supabaseAdminClient";
import { paths } from "../../../routes/paths";
import { saveGitHubIdentity } from "../../../lib/system/git/github/oauth";

export const dynamic = 'force-dynamic';

import { sanitizeReturnTo } from "../../../lib/auth/sanitize-return-to";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next");
  const returnTo = sanitizeReturnTo(searchParams.get("return_to"));
  const provider = searchParams.get("provider");
  const type = searchParams.get("type");

  // Helper to build redirect URL
  const buildRedirectUrl = (path: string, params?: Record<string, string>) => {
    const forwardedHost = request.headers.get("x-forwarded-host");
    const isLocalEnv = process.env.NODE_ENV === "development";
    const baseUrl = isLocalEnv ? origin : forwardedHost ? `https://${forwardedHost}` : origin;
    const url = new URL(path, baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }
    return url.toString();
  };

  // Handle email change verification
  if (type === "email_change") {
    const supabase = await createSupabaseServerClient();

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);

      if (error) {
        // Check for specific error types
        if (error.message?.includes("expired")) {
          return NextResponse.redirect(
            buildRedirectUrl(paths.profile.root, {
              email_change: "error",
              email_error: "expired",
            })
          );
        }
        if (error.message?.includes("already") || error.message?.includes("used")) {
          return NextResponse.redirect(
            buildRedirectUrl(paths.profile.root, {
              email_change: "error",
              email_error: "already_used",
            })
          );
        }
        // Generic error
        return NextResponse.redirect(
          buildRedirectUrl(paths.profile.root, {
            email_change: "error",
            email_error: "unknown",
          })
        );
      }

      // Email change successful
      return NextResponse.redirect(
        buildRedirectUrl(paths.profile.root, { email_change: "success" })
      );
    }

    // No code provided for email change
    return NextResponse.redirect(
      buildRedirectUrl(paths.profile.root, {
        email_change: "error",
        email_error: "missing_code",
      })
    );
  }

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error("[AuthCallback] exchangeCodeForSession failed:", {
        message: error.message,
        status: error.status,
        code: (error as any).code,
      });
      return NextResponse.redirect(`${origin}/auth/auth-code-error`);
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

      if (!user) {
        console.error("[AuthCallback] Code exchanged successfully but getUser returned null — possible session race or token reuse");
        return NextResponse.redirect(buildRedirectUrl(paths.auth.login));
      }

      // Create admin client early — needed for SSO identity upsert and registration flow
      const supabaseAdmin = createSupabaseAdminClient();

      // Detect SSO authentication and upsert SSO identity
      const amrClaims = (user.app_metadata?.amr ?? []) as Array<{ method: string; timestamp?: number }>;
      const isSSOLogin = amrClaims.some((claim) => claim.method === "sso/saml");

      if (isSSOLogin) {
        try {
          const userEmail = user.email;
          const domain = userEmail?.split("@")[1];

          if (domain) {
            const now = new Date().toISOString();

            // Find SSO config for this domain
            const { data: ssoConfig, error: ssoConfigError } = await supabaseAdmin
              .from("sso_config")
              .select("id, tenant_id")
              .contains("allowed_domains", [domain])
              .eq("is_active", true)
              .maybeSingle();

            if (ssoConfigError) {
              console.error("[SSO] Failed to query sso_config for domain:", domain, ssoConfigError);
            }

            if (ssoConfig) {
              // Upsert SSO identity (column names match sso_identity schema)
              const { error: upsertError } = await supabaseAdmin.from("sso_identity").upsert(
                {
                  sso_config_id: ssoConfig.id,
                  user_id: user.id,
                  tenant_id: ssoConfig.tenant_id,
                  external_subject_id: user.app_metadata?.provider_id ?? user.id,
                  // first_login_at intentionally excluded — DB DEFAULT handles insert; not updated on conflict
                  last_login_at: now,
                },
                {
                  onConflict: "tenant_id,user_id",
                }
              );

              if (upsertError) {
                console.error("[SSO] Failed to upsert SSO identity for user:", user.id, upsertError);
              }
            }
          }
        } catch (ssoError) {
          // Log but don't block login — SSO identity tracking is non-critical
          console.error("[SSO] Failed to upsert SSO identity:", ssoError);
        }
      }

      // IMPORTANT: The 'next' param distinguishes between two flows:
      // 1. Identity linking (next IS present): User already exists, just linking a new OAuth provider
      //    - Skips registration, only saves identity data (GitHub username, etc.)
      //    - Used by profile settings when linking additional providers
      // 2. Registration/login (next is NOT present): New or returning user authentication
      //    - Runs full processOAuthRegistration which creates profile, tenant, membership, billing
      //    - Register page (/auth/register) must NOT include 'next' param in OAuth redirects
      if (next) {
        const { data: identities } = await supabase.auth.getUserIdentities();
        let detectedProvider = provider;

        // Handle GitHub identity linking
        const githubIdentity = identities?.identities.find(
          (i) => i.provider === "github"
        );

        if (githubIdentity && (!provider || provider === "github")) {
          detectedProvider = "github";
          const githubUsername =
            githubIdentity.identity_data?.user_name ||
            githubIdentity.identity_data?.preferred_username;
          const githubEmail = githubIdentity.identity_data?.email;
          const githubUserId = githubIdentity.identity_data?.sub || githubIdentity.id;

          if (githubUsername) {
            await saveGitHubIdentity(supabase, githubUsername, githubEmail, githubUserId);
          }
        }

        // Redirect to the specified path with provider param for success message
        const forwardedHost = request.headers.get("x-forwarded-host");
        const isLocalEnv = process.env.NODE_ENV === "development";
        const baseUrl = isLocalEnv ? origin : forwardedHost ? `https://${forwardedHost}` : origin;

        // Security: Only allow safe relative paths to prevent open redirect attacks
        // 1. Must start with single forward slash
        // 2. Block protocol-relative URLs (//) and backslash variants (/\)
        // 3. Strip control characters and null bytes that could bypass checks
        const sanitizedNext = next.replace(/[\x00-\x1f\x7f]/g, "");
        const isSafePath =
          sanitizedNext.startsWith("/") &&
          !sanitizedNext.startsWith("//") &&
          !sanitizedNext.startsWith("/\\") &&
          !/^\/[^\w\-/]/.test(sanitizedNext); // Block /@ /: etc that some browsers resolve as URLs
        const safeNext = isSafePath ? sanitizedNext : paths.orgs.root;
        const redirectUrl = new URL(safeNext, baseUrl);

        if (detectedProvider) {
          redirectUrl.searchParams.set("provider", detectedProvider);
        }
        return NextResponse.redirect(redirectUrl.toString());
      }

      // Registration/login flow

      // Check if user already has a profile (existing user)
      // Note: We check profile, not membership, because with skip-company-setup
      // users may have completed registration but not yet created an organization
      const { data: existingProfile } = await supabaseAdmin
        .from("profile")
        .select("id")
        .eq("id", user.id)
        .maybeSingle();

      // Existing user - proceed normally (TermsGuard will handle re-consent if needed)
      // Honor `return_to` when set — that's the headless-link path where
      // the user landed on an OAuth callback or other deep link while
      // signed out, was bounced to /auth/login?return_to=..., and now
      // needs to be deposited at the original destination so the flow
      // resumes (e.g. /auth/github/callback?installation_id=...&state=...
      // re-runs with the new session and persists the git_connection).
      if (existingProfile) {
        const redirectPath = returnTo ?? paths.orgs.root;
        const forwardedHost = request.headers.get("x-forwarded-host");
        const isLocalEnv = process.env.NODE_ENV === "development";
        if (isLocalEnv) {
          return NextResponse.redirect(`${origin}${redirectPath}`);
        } else if (forwardedHost) {
          return NextResponse.redirect(`https://${forwardedHost}${redirectPath}`);
        } else {
          return NextResponse.redirect(`${origin}${redirectPath}`);
        }
      }

      // New user - redirect to terms agreement page
      // The terms agreement page will complete OAuth registration after user agrees,
      // then redirect to the `return_to` we pass through here (so the post-
      // terms flow still lands the user on the OAuth callback that started it).
      const forwardedHost = request.headers.get("x-forwarded-host");
      const isLocalEnv = process.env.NODE_ENV === "development";
      const baseUrl = isLocalEnv
        ? origin
        : forwardedHost
          ? `https://${forwardedHost}`
          : origin;

      const termsUrl = new URL("/auth/terms-agreement", baseUrl);
      termsUrl.searchParams.set("pending", "true");
      termsUrl.searchParams.set("return_to", returnTo ?? paths.orgs.root);
      return NextResponse.redirect(termsUrl.toString());
  }

  return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
