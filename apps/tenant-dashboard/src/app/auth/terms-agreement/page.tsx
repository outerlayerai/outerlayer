import { TermsAgreementView } from "@/features/auth";
import { createSupabaseServerClient } from "../../../supabaseServerClient";
import { redirect } from "next/navigation";
import { paths } from "../../../routes/paths";
import { recordTermsAgreementForUser } from "@/lib/system";
import { createOAuthRegistrationService } from "@/lib/system";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Terms Agreement",
};

interface PageProps {
  searchParams: Promise<{
    pending?: string;
    return_to?: string;
    blocking?: string;
  }>;
}

export default async function TermsAgreementPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const isPending = params.pending === "true";
  const isBlocking = params.blocking === "true";
  const returnTo = params.return_to || paths.orgs.root;

  // Get current user
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // If not authenticated, redirect to login
  if (!user) {
    redirect(paths.auth.login);
  }

  async function handleAgreeToTerms() {
    "use server";

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { error: "Authentication required" };
    }

    // If this is a pending OAuth registration, complete the registration FIRST
    // This creates the profile, which is required before recording terms agreement
    // (terms_agreement has a foreign key to profile)
    if (isPending) {
      const oauthRegistrationService = createOAuthRegistrationService();
      const registrationResult =
        await oauthRegistrationService.processOAuthRegistration(user);

      if ("error" in registrationResult) {
        // Registration failed - redirect to error form
        redirect("https://forms.gle/zvZHtM46kaKv7BZ99");
      }
    }

    // Now record the terms agreement (profile exists at this point)
    const termsResult = await recordTermsAgreementForUser(user.id);

    if (termsResult.error) {
      // Log but don't block - user has already registered
      console.error("[TermsAgreement] Failed to record terms:", termsResult.error);
    }

    // Redirect to the return path or orgs root
    const returnPath = returnTo || paths.orgs.root;
    redirect(returnPath);
  }

  return (
    <TermsAgreementView
      onAgree={handleAgreeToTerms}
      isPending={isPending}
      isBlocking={isBlocking}
      returnTo={returnTo}
    />
  );
}
