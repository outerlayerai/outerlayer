"use server";

import { revalidatePath } from "next/cache";

import { authorizedAction } from "@/lib/action-kit";

import { orgSettingsService } from "./service";
import { updateOrganizationInput } from "./schemas";

const GENERAL_SETTINGS_PATH = "/orgs/[orgName]/settings/general";

/**
 * Rename the org (`tenant.company_name`). Gated `tenant.update` — the RLS
 * UPDATE policy backs the same check, so a denial here and a denial at the
 * DB agree; the action just gets there first with a typed response instead
 * of a raw PostgREST error. `tenantId` always comes from the resolved
 * request context, never client input — the URL org, not a form field,
 * decides which tenant is written.
 */
export const updateOrganizationAction = authorizedAction({
  input: updateOrganizationInput,
  permission: "tenant.update",
  handler: async (ctx, input) => {
    const updated = await orgSettingsService.updateCompanyName(ctx, input);
    revalidatePath(GENERAL_SETTINGS_PATH, "page");
    return updated;
  },
});
