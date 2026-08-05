import { describe, it, expect } from 'vitest';
import { auditLogRowsToCsv, AUDIT_LOG_CSV_HEADER } from '../audit-log-csv';
import type { AuditLogDetail } from '@/types/platform-admin';

function makeDetail(overrides: Partial<AuditLogDetail> = {}): AuditLogDetail {
  return {
    id: 'log-1',
    actor_id: 'user-1',
    actor_type: 'human',
    actor_label: 'admin@acme.co',
    actor_email: 'admin@acme.co',
    actor_name: 'Admin One',
    tenant_id: 'tenant-1',
    ip_address: '203.0.113.9',
    user_agent: 'Mozilla/5.0',
    request_id: 'req-1',
    action_type: 'member_role_changed',
    target_type: 'membership',
    target_id: 'mem-1',
    target_identifier: 'member@acme.co',
    details: null,
    before_state: { role: 'read' },
    after_state: { role: 'admin' },
    created_at: '2026-07-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('auditLogRowsToCsv', () => {
  it('encodes a plain row exactly (header + CRLF line endings)', () => {
    const csv = auditLogRowsToCsv([makeDetail()]);

    expect(csv).toBe(
      AUDIT_LOG_CSV_HEADER +
        '\r\n' +
        '2026-07-09T10:00:00.000Z,member_role_changed,admin@acme.co,admin@acme.co,human,user-1,' +
        'membership,member@acme.co,mem-1,203.0.113.9,Mozilla/5.0,req-1,,' +
        '"{""role"":""read""}","{""role"":""admin""}"' +
        '\r\n'
    );
  });

  it('quotes values containing delimiters, quotes, and newlines (RFC 4180)', () => {
    const csv = auditLogRowsToCsv([
      makeDetail({
        target_identifier: 'role with, comma',
        user_agent: 'agent "quoted"\nsecond line',
      }),
    ]);

    expect(csv).toContain('"role with, comma"');
    expect(csv).toContain('"agent ""quoted""\nsecond line"');
  });

  it('neutralizes spreadsheet formula injection in attacker-controlled values', () => {
    // A custom role NAME is attacker-controlled and lands in target_identifier.
    const csv = auditLogRowsToCsv([
      makeDetail({ target_identifier: '=HYPERLINK("http://evil.example","x")' }),
      makeDetail({ target_identifier: '+1234' }),
      makeDetail({ target_identifier: '-cmd' }),
      makeDetail({ target_identifier: '@import' }),
    ]);

    // Each formula trigger is prefixed with a quote BEFORE quoting, so no
    // cell in the export begins with an executable character.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(csv).toContain("'+1234");
    expect(csv).toContain("'-cmd");
    expect(csv).toContain("'@import");
    for (const line of csv.split('\r\n').slice(1)) {
      for (const cell of line.split(',')) {
        expect(cell.startsWith('=')).toBe(false);
      }
    }
  });

  it('renders machine actors and empty context as empty cells', () => {
    const csv = auditLogRowsToCsv([
      makeDetail({
        actor_id: null,
        actor_type: 'gateway',
        actor_label: 'api-key-42',
        actor_email: null,
        actor_name: null,
        ip_address: null,
        user_agent: null,
        request_id: null,
        before_state: null,
        after_state: null,
      }),
    ]);

    expect(csv).toBe(
      AUDIT_LOG_CSV_HEADER +
        '\r\n' +
        '2026-07-09T10:00:00.000Z,member_role_changed,,api-key-42,gateway,,' +
        'membership,member@acme.co,mem-1,,,,,,' +
        '\r\n'
    );
  });

  it('never includes chain internals in the header', () => {
    expect(AUDIT_LOG_CSV_HEADER).not.toContain('seq');
    expect(AUDIT_LOG_CSV_HEADER).not.toContain('hash');
  });
});
