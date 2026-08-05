import { z } from "zod";

/**
 * Auth-form validation schemas, extracted from their view components so every
 * validation branch can be unit-tested directly (the components build these
 * inline on render; the logic is identical). `t` supplies localized messages.
 */
type Translate = (key: string) => string;

export function buildRegisterSchema(t: Translate) {
  return z.object({
    firstName: z.string().min(1, t("auth.validation.firstName.required")),
    lastName: z.string().min(1, t("auth.validation.lastName.required")),
    email: z
      .string()
      .min(1, t("auth.validation.email.required"))
      .email(t("auth.validation.email.invalid")),
    password: z
      .string()
      .min(1, t("auth.validation.password.required"))
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number")
      .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
    agreedToTerms: z
      .boolean()
      .refine((val) => val === true, "You must agree to the Terms of Service and Privacy Policy"),
  });
}

export function buildNewPasswordSchema(t: Translate) {
  return z
    .object({
      password: z
        .string()
        .min(1, t("auth.validation.password.required"))
        .min(6, t("auth.validation.password.min")),
      confirmPassword: z.string().min(1, t("auth.validation.password.required")),
    })
    .refine((data) => data.confirmPassword === data.password, {
      message: t("auth.validation.password.match"),
      path: ["confirmPassword"],
    });
}

export function buildLoginSchema(t: Translate, ssoEnforced: boolean) {
  return z.object({
    email: z
      .string()
      .min(1, t("auth.validation.email.required"))
      .email(t("auth.validation.email.invalid")),
    // Password is optional when SSO is enforced, otherwise required.
    password: ssoEnforced
      ? z.string().optional().default("")
      : z.string().min(1, t("auth.validation.password.required")),
  });
}

export function buildForgotPasswordSchema(t: Translate) {
  return z.object({
    email: z
      .string()
      .min(1, t("auth.validation.email.required"))
      .email(t("auth.validation.email.invalid")),
  });
}

/**
 * Server-action input schemas for `features/auth/actions.ts`. Unlike the
 * form schemas above, these have no `t` dependency — the messages they'd
 * produce never reach a form field, only the action's generic validation
 * failure.
 */
export const acceptInvitationInput = z.object({
  membershipId: z.string().min(1),
  agreedToTerms: z.boolean().optional().default(false),
});

export const getInvitationDetailsInput = z.object({
  membershipId: z.string().min(1),
});
