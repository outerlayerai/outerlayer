/**
 * Sanitize search terms for use in PostgREST filter strings.
 *
 * PostgREST filter syntax uses special characters that could be exploited
 * if user input is interpolated directly. This function escapes those characters.
 *
 * Special characters in PostgREST filters:
 * - % and _ are LIKE wildcards
 * - . separates column.operator
 * - , separates multiple conditions in or()
 * - () for grouping
 * - \ for escaping
 */
export function sanitizeSearchTerm(search: string): string {
  // Escape backslashes first (so we don't double-escape our own escapes)
  // Then escape PostgREST filter special characters
  return search
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\./g, '\\.')
    .replace(/,/g, '\\,')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}
