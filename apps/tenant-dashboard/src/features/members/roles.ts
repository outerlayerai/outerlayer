import { UserRoleEnum } from "@/lib/adapters/user-role";

interface BuiltInRole {
  value: string;
  label: string;
}

/**
 * The catalog `GET /roles` serves. Mirrors `UserRoleEnum` — the five real
 * `app_role` database values. A custom role is layered on top of the
 * built-in `read` fallback via `membership.custom_role_id`, not a sixth
 * value here (see `ee/features/custom-roles`).
 */
export const BUILT_IN_ROLES: BuiltInRole[] = [
  { value: UserRoleEnum.OWNER, label: "Owner" },
  { value: UserRoleEnum.ADMIN, label: "Admin" },
  { value: UserRoleEnum.WRITE, label: "Write" },
  { value: UserRoleEnum.READ, label: "Read" },
  { value: UserRoleEnum.DISABLED, label: "Disabled" },
];
