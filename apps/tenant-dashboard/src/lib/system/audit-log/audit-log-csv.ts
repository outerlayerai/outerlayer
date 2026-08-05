import "server-only";

import type { AuditLogDetail } from '@/types/platform-admin';

/**
 * CSV encoding for audit trail exports (RFC 4180 + spreadsheet-safety).
 *
 * Two hostile inputs matter here:
 *  1. Delimiters/quotes/newlines inside values (an attacker controls e.g. a
 *     custom role NAME that lands in target_identifier) — handled by RFC 4180
 *     quoting.
 *  2. CSV formula injection: values starting with = + - @ (or tab/CR) execute
 *     as formulas when the export is opened in Excel/Sheets. Per OWASP, such
 *     values are prefixed with a single quote BEFORE quoting.
 *
 * seq / prev_hash / row_hash are deliberately NOT exported: seq is a global
 * counter across all tenants (leaks platform write volume) and the chain
 * hashes are an internal integrity mechanism.
 */

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  let out = value;
  if (FORMULA_TRIGGERS.has(out[0]!)) {
    out = `'${out}`;
  }

  if (/[",\n\r]/.test(out)) {
    out = `"${out.replace(/"/g, '""')}"`;
  }

  return out;
}

function jsonCell(value: Record<string, unknown> | null): string {
  return csvCell(value ? JSON.stringify(value) : null);
}

export const AUDIT_LOG_CSV_HEADER = [
  'timestamp_utc',
  'action',
  'actor_email',
  'actor_label',
  'actor_type',
  'actor_id',
  'target_type',
  'target',
  'target_id',
  'ip_address',
  'user_agent',
  'request_id',
  'details',
  'before_state',
  'after_state',
].join(',');

export function auditLogRowsToCsv(rows: AuditLogDetail[]): string {
  const lines = rows.map((row) =>
    [
      csvCell(row.created_at),
      csvCell(row.action_type),
      csvCell(row.actor_email),
      csvCell(row.actor_label),
      csvCell(row.actor_type),
      csvCell(row.actor_id),
      csvCell(row.target_type),
      csvCell(row.target_identifier),
      csvCell(row.target_id),
      csvCell(row.ip_address),
      csvCell(row.user_agent),
      csvCell(row.request_id),
      jsonCell(row.details),
      jsonCell(row.before_state),
      jsonCell(row.after_state),
    ].join(',')
  );

  return [AUDIT_LOG_CSV_HEADER, ...lines].join('\r\n') + '\r\n';
}
