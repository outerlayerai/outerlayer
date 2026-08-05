/**
 * Scrub email addresses for logging purposes.
 * Masks the local part while preserving the domain for debugging.
 *
 * @example
 * scrubEmail("john.doe@example.com") // "joh***@example.com"
 * scrubEmail("ab@test.io") // "ab***@test.io"
 */
export function scrubEmail(email: string): string {
  if (!email || typeof email !== "string") return "[invalid]";
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "[invalid]";
  return `${parts[0].slice(0, 3)}***@${parts[1]}`;
}
