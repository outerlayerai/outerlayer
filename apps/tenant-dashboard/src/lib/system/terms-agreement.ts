import "server-only";

import { headers } from "next/headers";
import { SupabaseClient } from "@supabase/supabase-js";
import { serverLogger } from "@/lib/adapters";
import { getAdminDataClient } from "./admin-client";
import { ServerActionResponse } from "@/types/server-action";
import { TERMS_VERSION } from "@/config/terms";
import {
  ConsentType,
  ITermsAgreementService,
  RecordAgreementParams,
  TermsAgreementRecord,
  TermsCheckResult,
} from "./terms-agreement-types";

interface TermsAgreementServiceConfig {
  supabaseAdmin: SupabaseClient;
}

// ============================================================================
// Terms Agreement Service
// ============================================================================

/**
 * Service for managing terms agreement records.
 * Handles recording user consent to Terms of Service and Privacy Policy.
 */
export class TermsAgreementService implements ITermsAgreementService {
  private supabaseAdmin: SupabaseClient;

  constructor(config: TermsAgreementServiceConfig) {
    this.supabaseAdmin = config.supabaseAdmin;
  }

  /**
   * Records a user's agreement to terms.
   * Creates an append-only audit record.
   *
   * @throws Error if agreement already exists for this version
   */
  async recordAgreement(params: RecordAgreementParams): Promise<TermsAgreementRecord> {
    const { userId, termsVersion, ipAddress, userAgent, consentType = "explicit" } = params;

    const { data, error } = await this.supabaseAdmin
      .from("terms_agreement")
      .insert({
        user_id: userId,
        terms_version: termsVersion,
        agreed_at: new Date().toISOString(),
        ip_address: ipAddress || null,
        user_agent: userAgent || null,
        consent_type: consentType,
        created_by: userId,
      })
      .select()
      .single();

    if (error) {
      // Check for unique constraint violation
      if (error.code === "23505") {
        throw new Error(`User has already agreed to terms version ${termsVersion}`);
      }
      await serverLogger.error(new Error(error.message), {
        context: "TermsAgreementService.recordAgreement",
        userId,
        termsVersion,
      });
      throw new Error("Failed to record terms agreement");
    }

    return this.mapToRecord(data);
  }

  /**
   * Checks if a user has agreed to ANY version of terms.
   * Used for non-blocking policy - users with any existing agreement
   * are never blocked when terms are updated.
   */
  async hasAnyAgreement(userId: string): Promise<boolean> {
    const { data, error } = await this.supabaseAdmin
      .from("terms_agreement")
      .select("id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();

    if (error) {
      await serverLogger.error(new Error(error.message), {
        context: "TermsAgreementService.hasAnyAgreement",
        userId,
      });
      throw new Error("Failed to check terms agreement");
    }

    return data !== null;
  }

  /**
   * Gets the latest agreement for a user.
   */
  async getLatestAgreement(userId: string): Promise<TermsAgreementRecord | null> {
    const { data, error } = await this.supabaseAdmin
      .from("terms_agreement")
      .select("*")
      .eq("user_id", userId)
      .order("agreed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      await serverLogger.error(new Error(error.message), {
        context: "TermsAgreementService.getLatestAgreement",
        userId,
      });
      throw new Error("Failed to get latest agreement");
    }

    return data ? this.mapToRecord(data) : null;
  }

  /**
   * Checks user's terms agreement status against current version.
   * Used by TermsGuard to determine if user needs to agree.
   *
   * Note: With the non-blocking policy (002-terms-update-policy),
   * needsCurrentVersion is only true when the user has NO agreement at all.
   * Users with any existing agreement are never blocked.
   */
  async checkTermsStatus(userId: string, _currentVersion: string): Promise<TermsCheckResult> {
    const latestAgreement = await this.getLatestAgreement(userId);

    if (!latestAgreement) {
      return {
        hasAgreed: false,
        needsCurrentVersion: true,
      };
    }

    // Non-blocking policy: Users with ANY agreement are never blocked.
    // We still track the version for potential implicit acceptance logging.
    return {
      hasAgreed: true,
      agreedVersion: latestAgreement.termsVersion,
      agreedAt: latestAgreement.agreedAt,
      consentType: latestAgreement.consentType,
      needsCurrentVersion: false, // Never block users with existing agreements
    };
  }

  /**
   * Maps database row to TermsAgreementRecord.
   */
  private mapToRecord(row: any): TermsAgreementRecord {
    return {
      id: row.id,
      userId: row.user_id,
      termsVersion: row.terms_version,
      agreedAt: new Date(row.agreed_at),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      consentType: row.consent_type as ConsentType,
      createdAt: new Date(row.created_at),
      createdBy: row.created_by,
    };
  }
}

/**
 * Extracts client IP address from request headers.
 */
async function getClientIp(): Promise<string | undefined> {
  const headersList = await headers();
  const forwardedFor = headersList.get("x-forwarded-for");
  const realIp = headersList.get("x-real-ip");
  return forwardedFor?.split(",")[0]?.trim() || realIp || undefined;
}

/**
 * Extracts user agent from request headers.
 */
async function getUserAgent(): Promise<string | undefined> {
  const headersList = await headers();
  return headersList.get("user-agent") || undefined;
}

/**
 * Records terms agreement for a user during registration or invite
 * acceptance. Runs on the service-role client because both callers invoke it
 * before (or entirely without) a session: registration records consent for a
 * user who has no cookie-bound session yet, and invite acceptance runs for a
 * user whose membership isn't active until the accept completes.
 *
 * A plain function, not a server action: every caller is in-process (the
 * register page's own `"use server"` closure, the terms-agreement page's
 * closure, and `acceptInvitation`), so no client ever invokes this directly.
 * It trusts its `userId` argument with no session cross-check — an
 * intentionally narrow surface, but still forgeable by anything that can
 * call it in-process; tightening that is a deliberate follow-up with its own
 * reasoning about the pre-session registration call, not a side effect of
 * this function's shape.
 *
 * @param userId - The ID of the user to record the agreement for
 * @returns The agreement record ID and version
 */
export async function recordTermsAgreementForUser(
  userId: string
): Promise<ServerActionResponse<{ agreementId: string; termsVersion: string }>> {
  if (!userId) {
    return { error: "User ID is required" };
  }

  const service = new TermsAgreementService({ supabaseAdmin: getAdminDataClient() });
  const ipAddress = await getClientIp();
  const userAgent = await getUserAgent();

  try {
    const record = await service.recordAgreement({
      userId,
      termsVersion: TERMS_VERSION,
      ipAddress,
      userAgent,
    });

    return {
      data: {
        agreementId: record.id,
        termsVersion: record.termsVersion,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record agreement";

    // Already agreed is acceptable during registration retry
    if (message.includes("already agreed")) {
      return {
        data: {
          agreementId: "existing",
          termsVersion: TERMS_VERSION,
        },
      };
    }

    // Log but don't fail registration for terms recording failure
    console.error("[Terms] Failed to record agreement for user:", userId, message);
    return { error: message };
  }
}
