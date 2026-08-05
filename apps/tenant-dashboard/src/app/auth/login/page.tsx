import { LoginView } from "@/features/auth";
import { createSupabaseServerClient } from "../../../supabaseServerClient";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { sanitizeReturnTo } from "../../../lib/auth/sanitize-return-to";
import { buildOAuthRedirectTarget } from "../../../lib/auth/oauth-redirect";

export const dynamic = 'force-dynamic';

export const metadata = {
  title: "Login",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const { return_to } = await searchParams;
  const returnTo = sanitizeReturnTo(return_to);

  async function loginWithGithub(returnToArg?: string | null) {
    "use server";
    const supabase = await createSupabaseServerClient();

    const headerList = await headers();

    const origin = headerList.get("origin");

    // Don't include 'next' param - that's for identity linking only.
    // `return_to` is the general post-login destination (e.g. a
    // git-connect callback URL the user landed on while signed out).
    // Registration flow handles both new and returning users correctly.
    const { data } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: buildOAuthRedirectTarget(
          origin!,
          sanitizeReturnTo(returnToArg ?? undefined),
        ),
      },
    });

    redirect(data?.url!);
  }

  async function loginWithGoogle(returnToArg?: string | null) {
    "use server";
    const supabase = await createSupabaseServerClient();

    const headerList = await headers();

    const origin = headerList.get("origin");

    const { data } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: buildOAuthRedirectTarget(
          origin!,
          sanitizeReturnTo(returnToArg ?? undefined),
        ),
      },
    });

    redirect(data?.url!);
  }

  async function loginWithSSO(email: string, returnToArg?: string | null) {
    "use server";
    const supabase = await createSupabaseServerClient();
    const headerList = await headers();
    const origin = headerList.get("origin");

    if (!origin) {
      throw new Error("Unable to determine redirect origin — SSO login is unavailable in this context");
    }

    const domain = email.split("@")[1];
    if (!domain) {
      throw new Error("Invalid email address");
    }

    const { data, error } = await supabase.auth.signInWithSSO({
      domain,
      options: {
        redirectTo: buildOAuthRedirectTarget(
          origin,
          sanitizeReturnTo(returnToArg ?? undefined),
        ),
      },
    });

    if (error) {
      throw error;
    }

    redirect(data.url);
  }

  return (
    <LoginView
      loginWithGithub={loginWithGithub}
      loginWithGoogle={loginWithGoogle}
      loginWithSSO={loginWithSSO}
      returnTo={returnTo}
    />
  );
}
