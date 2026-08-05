import "server-only";

import { getAdminDataClient } from "../admin-client";
import { validateBusinessEmail } from "../../validation";
import { User } from "@supabase/supabase-js";
import { OAuthRegistrationServiceConfig } from "./types";
import { logServerError, logServerInfo } from "../../adapters/server-error-log";
import { scrubEmail } from "../../../utils/scrub-email";

/**
 * Simplified OAuth Registration Service
 *
 * With skip-company-setup, OAuth registration only creates:
 * 1. Profile record (auth user already created by Supabase OAuth flow)
 *
 * Organization/tenant creation is deferred to /orgs page via OrganizationService.
 * No saga pattern needed - just profile creation.
 */
export class OAuthRegistrationService {
  private supabaseAdmin: any;

  constructor(_config: OAuthRegistrationServiceConfig = {}) {
    this.supabaseAdmin = getAdminDataClient();
  }

  private findGitHubProvider(user: User): any {
    return user.identities?.find((identity: any) => identity.provider === "github");
  }

  /**
   * Process OAuth registration for a user.
   * Creates profile only - auth user already exists from OAuth flow.
   */
  async processOAuthRegistration(
    user: User
  ): Promise<{ userId: string; tenantId?: string } | { error: string }> {
    // Validate email
    if (!user.email) {
      return { error: "Email is required for registration." };
    }

    const emailValidation = validateBusinessEmail(user.email);
    if (!emailValidation.isValid) {
      return { error: emailValidation.error || "Invalid email address" };
    }

    // Check if user already has a profile (returning user)
    const { data: existingProfile } = await this.supabaseAdmin
      .from("profile")
      .select("id, github_username")
      .eq("id", user.id)
      .maybeSingle();

    if (existingProfile) {
      // Existing user - update GitHub username if needed
      if (!existingProfile.github_username) {
        const githubProvider = this.findGitHubProvider(user);
        if (githubProvider?.identity_data?.user_name) {
          await this.supabaseAdmin
            .from("profile")
            .update({ github_username: githubProvider.identity_data.user_name })
            .eq("id", user.id);
        }
      }

      // Check if user has any memberships
      const { data: membership } = await this.supabaseAdmin
        .from("membership")
        .select("tenant_id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      return {
        userId: user.id,
        tenantId: membership?.tenant_id,
      };
    }

    // New user - create profile
    try {
      const meta = user.user_metadata || {};
      const custom = (meta.custom_claims as Record<string, unknown> | undefined) || {};

      const firstName = (meta.first_name as string | undefined) ?? (custom.first_name as string | undefined);
      const lastName = (meta.last_name as string | undefined) ?? (custom.last_name as string | undefined);
      const joinedName = [firstName, lastName].filter(Boolean).join(' ') || undefined;

      const displayName =
        (meta.full_name as string | undefined) ||
        (custom.full_name as string | undefined) ||
        (meta.name as string | undefined) ||
        (custom.name as string | undefined) ||
        joinedName ||
        user.email;
      const githubProvider = this.findGitHubProvider(user);
      const githubUsername = githubProvider?.identity_data?.user_name;

      const { error: profileError } = await this.supabaseAdmin
        .from("profile")
        .insert({
          id: user.id,
          email: user.email,
          name: displayName,
          github_username: githubUsername,
        });

      if (profileError) {
        await logServerError(
          new Error(profileError.message || 'Failed to create profile'),
          { userId: user.id, email: scrubEmail(user.email) }
        );
        return { error: "Registration failed. Please try again or contact support if the problem persists." };
      }

      await logServerInfo("OAuth registration successful", { userId: user.id, email: scrubEmail(user.email) });

      return {
        userId: user.id,
        // No tenantId - user will create org later via /orgs page
      };
    } catch (error) {
      await logServerError(
        error instanceof Error ? error : new Error('OAuth registration failed'),
        { userId: user.id, email: scrubEmail(user.email) }
      );
      return { error: "Registration failed. Please try again or contact support if the problem persists." };
    }
  }
}

// Factory function
export function createOAuthRegistrationService(
  config: OAuthRegistrationServiceConfig = {}
): OAuthRegistrationService {
  return new OAuthRegistrationService(config);
}
