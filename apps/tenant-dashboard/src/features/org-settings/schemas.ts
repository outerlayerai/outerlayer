import { z } from "zod";

/** The org-general form's only editable field. `tenant.organization_name` is
 *  immutable post-creation (unique, used for URL routing) so it never appears here. */
export const updateOrganizationInput = z.object({
  companyName: z.string().min(1, "Company name is required"),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationInput>;
