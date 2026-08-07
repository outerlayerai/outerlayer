import { Session, User } from "@supabase/supabase-js";
import { Database } from "../types/db";
import { Tenant } from "../types/tenant";
import { MembershipWithTenant, ActiveTenant } from "../types/membership";
import { EmailChangeResult } from "../types/email-change";

export type ActionMapType<M extends { [index: string]: any }> = {
  [Key in keyof M]: M[Key] extends undefined
    ? {
        type: Key;
      }
    : {
        type: Key;
        payload: M[Key];
      };
};

export type AuthUserType =
  | null
  | ({
      permissions?: RolePermission[];
      /** The URL org `permissions` were fetched under. The fetch resolves its
       *  tenant from the request URL, so the set is only valid while the URL
       *  org matches; the provider refetches when they diverge. */
      permissionsOrg?: string;
      tenant?: Tenant | null;
      /** All organizations the user belongs to */
      memberships?: MembershipWithTenant[];
      /** Currently active organization context */
      activeTenant?: ActiveTenant | null;
    } & Record<string, any>);

export type AuthStateType = {
  status?: string;
  loading: boolean;
  user: AuthUserType;
};

type CanRemove = {
  login?: (email: string, password: string) => Promise<void>;
  register?: (
    email: string,
    password: string,
    firstName: string,
    lastName: string
  ) => Promise<{ user: User | null; session: Session | null }>;
  //
  loginWithGoogle?: () => Promise<void>;
  loginWithGithub?: () => Promise<void>;
  loginWithTwitter?: () => Promise<void>;
  confirmRegister?: (email: string, code: string) => Promise<void>;
  forgotPassword?: (email: string) => Promise<void>;
  resendCodeRegister?: (email: string) => Promise<void>;
  newPassword?: (
    email: string,
    code: string,
    password: string
  ) => Promise<void>;
  updatePassword?: (password: string) => Promise<void>;
};

export type SupabaseContextType = CanRemove & {
  user: AuthUserType;
  method: string;
  loading: boolean;
  authenticated: boolean;
  unauthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    firstName: string,
    lastName: string
  ) => Promise<{ user: User | null; session: Session | null }>;
  logout: () => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  /** Request email change. Sends verification to both old and new email addresses. */
  updateEmail: (newEmail: string) => Promise<EmailChangeResult>;
  /** Refresh memberships and update auth state. Returns promise that resolves when state is updated. */
  refreshMemberships: () => Promise<void>;
};

export type UserRole = Database["public"]["Enums"]["app_role"];

// Const object for convenient access while maintaining type safety.
// role is always a real built-in; a custom role is active when the membership's
// custom_role_id is set — there is no 'custom' role value.
export const UserRoleEnum = {
  OWNER: "owner" as const,
  ADMIN: "admin" as const,
  WRITE: "write" as const,
  READ: "read" as const,
  DISABLED: "disabled" as const,
} satisfies Record<string, UserRole>;

type RolePermission = Database["public"]["Tables"]["role_permissions"]["Row"];
