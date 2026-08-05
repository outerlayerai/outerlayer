import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/supabaseServerClient";

import { resolveLicenseStatus } from "@ee/features/license/service";
import type { LicenseStatus } from "@ee/features/license/types";

// License state is resolved per-request from server-only env (the license key
// never reaches the client), so the response must never be statically cached.
export const dynamic = "force-dynamic";

/**
 * GET /api/license/status
 *
 * Client-readable projection of the self-host enterprise license — the verified
 * claims (org, plan, expiry) and a derived display state, NEVER the raw key.
 * The client grace banner reads its state here; the settings page resolves the
 * same helper server-side.
 *
 * Fails closed to `{ visible: false }`: on any resolution error the license
 * surface stays HIDDEN rather than flashing a false "unlicensed"/grace state.
 * Cloud deployments also resolve to `{ visible: false }` — the surface only
 * exists on self-host.
 *
 * Requires a session. The body carries the licensed ORGANIZATION NAME and the
 * expiry date, so unauthenticated it let anyone scanning self-hosted instances
 * attribute each one to a company and date its renewal. The only consumer is the
 * grace banner, which renders to signed-in users, so there is nothing to gain
 * from anonymous access. Fails closed the same way: an unauthenticated caller
 * gets `{ visible: false }` rather than a 401, since the surface legitimately
 * does not exist for them and a distinct status code would still confirm that
 * the instance is licensed.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      const hidden: LicenseStatus = { visible: false };
      return NextResponse.json(hidden);
    }

    const status = await resolveLicenseStatus();
    return NextResponse.json(status);
  } catch {
    const hidden: LicenseStatus = { visible: false };
    return NextResponse.json(hidden);
  }
}
