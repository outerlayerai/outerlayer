/**
 * The current Terms of Service / Privacy Policy version.
 *
 * Single source of truth for every terms-agreement check and record write
 * (registration, invitation acceptance, the blocking TermsGuard). Bumping
 * this value is how a new terms version is rolled out.
 */
export const TERMS_VERSION = process.env.NEXT_PUBLIC_TERMS_VERSION || "2026-01-10";
