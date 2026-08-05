import { Database } from "./db";
import { Tenant } from "./tenant";

/**
 * Membership status enum
 * - pending: Invited but not yet accepted
 * - active: Full member of the organization
 */
type MembershipStatus = "pending" | "active";

/**
 * Base membership row type (will be auto-generated after migration)
 * Until db.ts is regenerated, we define this manually
 */
interface MembershipRow {
  id: string;
  user_id: string;
  tenant_id: string;
  status: MembershipStatus;
  invited_at: string | null;
  invited_by: string | null;
  expires_at: string | null;
  created_at: string;
}

/**
 * Membership with joined tenant and role information
 * Used for displaying organizations in the org switcher
 */
export interface MembershipWithTenant extends MembershipRow {
  tenant: Tenant;
  role: Database["public"]["Enums"]["app_role"];
}

/**
 * Active tenant context derived from memberships
 * Represents the currently selected organization
 */
export interface ActiveTenant {
  tenant_id: string;
  organization_name: string;
  company_name: string;
  role: Database["public"]["Enums"]["app_role"];
}
