import { RegisterView } from "@/features/auth";
import { redirect } from "next/navigation";
import { paths } from "../../../routes/paths";
import { headers } from "next/headers";
import { createEmailRegistrationService } from "@/lib/system";
import { createSupabaseServerClient } from "../../../supabaseServerClient";
import { recordTermsAgreementForUser } from "@/lib/system";
import { sanitizeReturnTo } from "../../../lib/auth/sanitize-return-to";
import { buildOAuthRedirectTarget } from "../../../lib/auth/oauth-redirect";

export const dynamic = 'force-dynamic';

export const metadata = {
  title: "Register",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const { return_to } = await searchParams;
  const returnTo = sanitizeReturnTo(return_to);

  // Users create organizations later via /orgs page
  async function handleFinalizeRegistration(
    email: string,
    password: string,
    firstName: string,
    lastName: string,
    redirectUrl: string
  ) {
    "use server";

    const registrationService = createEmailRegistrationService();

    const result = await registrationService.registerUser(
      email,
      password,
      firstName,
      lastName,
      redirectUrl
    );

    if (result && result.error) {
      return result;
    }

    // Record terms agreement for the newly created user
    // This is fire-and-forget - we don't fail registration if terms recording fails
    if (result.data?.userId) {
      await recordTermsAgreementForUser(result.data.userId);
    }

    // Carry `return_to` onto the verify page: when email confirmation is
    // disabled the user already has a session there, and GuestGuard resumes
    // the original flow (e.g. the invite's accept page) from this param.
    const searchParams = new URLSearchParams({
      email: email,
      ...(returnTo ? { return_to: returnTo } : {}),
    }).toString();

    const href = `${paths.auth.verify}?${searchParams}`;

    redirect(href);
  }

  async function registerWithGithub(returnToArg?: string | null) {
    "use server";
    const supabase = await createSupabaseServerClient();

    const headerList = await headers();

    const origin = headerList.get("origin");

    // Don't include 'next' param - that's for identity linking only.
    // `return_to` is the general post-auth destination (e.g. the invite
    // accept page the user landed on while signed out); the callback's
    // registration flow threads it through terms agreement.
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

  async function registerWithGoogle(returnToArg?: string | null) {
    "use server";
    const supabase = await createSupabaseServerClient();

    const headerList = await headers();

    const origin = headerList.get("origin");

    // Don't include 'next' param - that's for identity linking only.
    // `return_to` is the general post-auth destination (e.g. the invite
    // accept page the user landed on while signed out); the callback's
    // registration flow threads it through terms agreement.
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

  return (
    <RegisterView
      finalizeRegistration={handleFinalizeRegistration}
      registerWithGithub={registerWithGithub}
      registerWithGoogle={registerWithGoogle}
      returnTo={returnTo}
    />
  );
}
