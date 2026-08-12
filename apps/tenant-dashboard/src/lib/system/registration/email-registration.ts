import "server-only";

import { getAdminDataClient } from "../admin-client";
import { SUPABASE_API } from "../../../config-global";
import { createClient } from "@supabase/supabase-js";
import { ServerActionResponse } from "../../../types/server-action";
import { z } from "zod";
import { RegistrationServiceConfig } from "./types";
import { logServerError, logServerInfo } from "../../adapters/server-error-log";
import { scrubEmail } from "../../../utils/scrub-email";

/**
 * Simplified Email Registration Service
 *
 * With skip-company-setup, registration only creates:
 * 1. Auth user (via Supabase signUp)
 * 2. Profile record
 *
 * Organization/tenant creation is deferred to /orgs page via OrganizationService.
 * No saga pattern needed - just two simple operations.
 */
export class EmailRegistrationService {
  private supabaseAdmin: any;
  private supabase: any;

  constructor(config: RegistrationServiceConfig = {}) {
    this.supabaseAdmin = getAdminDataClient();
    this.supabase = config.supabaseClient || createClient(
      SUPABASE_API.url,
      SUPABASE_API.key
    );
  }

  /**
   * Register a new user with email and password.
   * Creates auth user and profile only - no organization.
   */
  async registerUser(
    email: string,
    password: string,
    firstName: string,
    lastName: string,
    redirectUrl: string
  ): Promise<ServerActionResponse<{ userId: string }>> {

    // Step 1: Validate input
    const schema = z.object({
      email: z
        .string()
        .trim()
        .toLowerCase()
        .min(1, "Email is required")
        .email("Invalid email address"),
      password: z
        .string()
        .min(1, "Password is required")
        .min(8, "Password must be at least 8 characters")
        .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
        .regex(/[a-z]/, "Password must contain at least one lowercase letter")
        .regex(/[0-9]/, "Password must contain at least one number")
        .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
      firstName: z.string().trim().min(1, "First name is required"),
      lastName: z.string().trim().min(1, "Last name is required"),
      redirectUrl: z.string().min(1, "Redirect URL is required"),
    });

    try {
      const validated = schema.parse({ email, password, firstName, lastName, redirectUrl });
      email = validated.email;
      firstName = validated.firstName;
      lastName = validated.lastName;
      redirectUrl = validated.redirectUrl;
    } catch (err: any) {
      // Return the first specific validation message (ZodError.message is a JSON
      // blob, so read the first issue instead).
      const message =
        err instanceof z.ZodError
          ? err.issues[0]?.message ?? "Invalid input data. Please check your information and try again."
          : err?.message || "Invalid input data. Please check your information and try again.";
      return { error: message };
    }

    const fullName = `${firstName} ${lastName}`;

    // Step 4: Create auth user
    const { error: signupError, data: { user } } = await this.supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: { display_name: fullName },
      },
    });

    if (signupError || !user) {
      const errorMessage = signupError?.message?.toLowerCase() || '';

      // "User already registered" is expected (unconfirmed duplicate) — log at INFO, not ERROR,
      // to avoid Sentry noise. Same treatment as the empty-identities check below.
      if (errorMessage.includes('user already registered')) {
        await logServerInfo('Registration rejected - email exists (unconfirmed)', { email: scrubEmail(email) });
        return { error: "Registration failed. Please try again or contact support if the problem persists." };
      }

      await logServerError(
        new Error(signupError?.message || 'Auth signup failed'),
        { email: scrubEmail(email), step: 'signup' }
      );

      // Provide specific feedback for password-related errors (safe to show to user)
      if (errorMessage.includes('password') || errorMessage.includes('weak')) {
        return { error: signupError?.message || "Password does not meet security requirements. Please choose a stronger password." };
      }

      return { error: "Registration failed. Please try again or contact support if the problem persists." };
    }

    // Supabase returns empty identities[] when the email already belongs to a confirmed user (anti-enumeration).
    if (!user.identities || user.identities.length === 0) {
      await logServerInfo('Registration rejected - email exists', { email: scrubEmail(email) });
      return { error: "Registration failed. Please try again or contact support if the problem persists." };
    }

    // Step 5: Create profile
    const { error: profileError } = await this.supabaseAdmin
      .from('profile')
      .insert({
        id: user.id,
        email: email,
        name: fullName,
      });

    if (profileError) {
      const isDuplicate = (profileError as { code?: string }).code === '23505';

      await logServerError(
        new Error(profileError.message || 'Profile creation failed'),
        { userId: user.id, email: scrubEmail(email), step: 'profile', duplicate: isDuplicate }
      );

      // Defense-in-depth: never delete an existing user's auth row if the profile already exists.
      if (!isDuplicate) {
        try {
          await this.supabaseAdmin.auth.admin.deleteUser(user.id);
          await logServerInfo('Cleaned up auth user after profile failure', { userId: user.id });
        } catch (cleanupError) {
          await logServerError(
            cleanupError instanceof Error ? cleanupError : new Error('Failed to cleanup auth user'),
            { userId: user.id }
          );
        }
      }

      return { error: "Registration failed. Please try again or contact support if the problem persists." };
    }

    await logServerInfo('Registration successful', { userId: user.id, email: scrubEmail(email) });

    return {
      data: { userId: user.id }
    };
  }
}

// Factory function
export function createEmailRegistrationService(config: RegistrationServiceConfig = {}): EmailRegistrationService {
  return new EmailRegistrationService(config);
}
