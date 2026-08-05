import { describe, it, expect } from 'vitest';
import { validateContent } from './validator.js';

describe('Migration Validator', () => {
  // Supabase/PostgreSQL tests removed - Squawk handles this (see squawk.contract.test.ts)

  describe('ClickHouse Migrations', () => {
    describe('DROP operations', () => {
      it('should detect DROP TABLE', () => {
        const sql = `
          DROP TABLE otel_traces;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'DROP_TABLE')).toBe(true);
      });

      it('should detect DROP COLUMN', () => {
        const sql = `
          ALTER TABLE otel_traces DROP COLUMN old_field;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'DROP_COLUMN')).toBe(true);
      });

      it('should detect DROP INDEX as warning', () => {
        const sql = `
          DROP INDEX idx_trace_id ON otel_traces;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(true); // Warnings don't fail by default
        expect(result.violations.some((v) => v.rule.id === 'DROP_INDEX')).toBe(true);
        expect(result.violations[0]?.rule.severity).toBe('warning');
      });
    });

    describe('ClickHouse-specific operations', () => {
      it('should detect DROP PARTITION', () => {
        const sql = `
          ALTER TABLE otel_traces DROP PARTITION '2024-01';
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'CLICKHOUSE_DROP_PARTITION')).toBe(true);
      });

      it('should detect CLEAR COLUMN', () => {
        const sql = `
          ALTER TABLE otel_traces CLEAR COLUMN deprecated_field;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'CLICKHOUSE_CLEAR_COLUMN')).toBe(true);
      });

      it('should detect MODIFY COLUMN', () => {
        const sql = `
          ALTER TABLE otel_traces MODIFY COLUMN user_id String;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'MODIFY_COLUMN')).toBe(true);
      });

      it('should detect DROP PROJECTION as warning (not error)', () => {
        const sql = `
          ALTER TABLE otel_traces DROP PROJECTION proj_by_tenant;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(true); // Warnings don't fail by default
        expect(result.violations.some((v) => v.rule.id === 'CLICKHOUSE_DROP_PROJECTION')).toBe(true);
        expect(result.violations[0]?.rule.severity).toBe('warning');
      });

      it('should NOT flag DROP PROJECTION as DROP COLUMN', () => {
        const sql = `
          ALTER TABLE otel_traces DROP PROJECTION proj_by_tenant;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.violations.some((v) => v.rule.id === 'DROP_COLUMN')).toBe(false);
      });
    });

    describe('RENAME operations', () => {
      it('should detect RENAME TABLE', () => {
        const sql = `
          ALTER TABLE otel_traces RENAME TO otel_spans;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'RENAME_TABLE')).toBe(true);
      });

      it('should detect RENAME COLUMN', () => {
        const sql = `
          ALTER TABLE otel_traces RENAME COLUMN span_name TO SpanName;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'RENAME_COLUMN')).toBe(true);
      });
    });

    describe('TRUNCATE operations', () => {
      it('should detect TRUNCATE TABLE', () => {
        const sql = `
          TRUNCATE TABLE otel_traces;
        `;
        const result = validateContent(sql, 'clickhouse');

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'TRUNCATE_TABLE')).toBe(true);
      });
    });

  });

  describe('Validator Options', () => {
    it('should fail on warnings when failOnWarnings is true', () => {
      const sql = `
        DROP INDEX idx_trace_id ON otel_traces;
      `;
      const result = validateContent(sql, 'clickhouse', 'test.sql', { failOnWarnings: true });

      expect(result.passed).toBe(false);
    });

    it('should skip rules when specified', () => {
      const sql = `
        DROP TABLE otel_traces;
      `;
      const result = validateContent(sql, 'clickhouse', 'test.sql', { skipRules: ['DROP_TABLE'] });

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('Inline suppression (-- validator:allow)', () => {
    it('should suppress a rule when comment is on the line before', () => {
      const sql = `-- validator:allow MODIFY_COLUMN
ALTER TABLE otel_traces MODIFY COLUMN Input String CODEC(ZSTD(3));`;
      const result = validateContent(sql, 'clickhouse');

      expect(result.passed).toBe(true);
      expect(result.violations.some((v) => v.rule.id === 'MODIFY_COLUMN')).toBe(false);
    });

    it('should suppress a rule when comment is on the same line', () => {
      const sql = `ALTER TABLE otel_traces MODIFY COLUMN Input String CODEC(ZSTD(3)); -- validator:allow MODIFY_COLUMN`;
      const result = validateContent(sql, 'clickhouse');

      expect(result.passed).toBe(true);
      expect(result.violations.some((v) => v.rule.id === 'MODIFY_COLUMN')).toBe(false);
    });

    it('should suppress multiple rules in one comment', () => {
      const sql = `-- validator:allow MODIFY_COLUMN DROP_TABLE
ALTER TABLE otel_traces MODIFY COLUMN Input String;`;
      const result = validateContent(sql, 'clickhouse');

      expect(result.violations.some((v) => v.rule.id === 'MODIFY_COLUMN')).toBe(false);
    });

    it('should NOT suppress rules without matching comment', () => {
      const sql = `-- validator:allow DROP_TABLE
ALTER TABLE otel_traces MODIFY COLUMN Input String;`;
      const result = validateContent(sql, 'clickhouse');

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.rule.id === 'MODIFY_COLUMN')).toBe(true);
    });

    it('should suppress all MODIFY_COLUMN in a codec-only migration', () => {
      const sql = `-- Codec-only changes, safe for production
-- validator:allow MODIFY_COLUMN
ALTER TABLE otel_traces MODIFY COLUMN Input String DEFAULT '' CODEC(ZSTD(3));
-- validator:allow MODIFY_COLUMN
ALTER TABLE otel_traces MODIFY COLUMN Output String DEFAULT '' CODEC(ZSTD(3));
-- validator:allow MODIFY_COLUMN
ALTER TABLE otel_traces MODIFY COLUMN Props String DEFAULT '' CODEC(ZSTD(3));`;
      const result = validateContent(sql, 'clickhouse');

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should only suppress the adjacent line, not distant ones', () => {
      const sql = `-- validator:allow MODIFY_COLUMN
ALTER TABLE otel_traces MODIFY COLUMN Input String CODEC(ZSTD(3));
SELECT 1;
ALTER TABLE otel_traces MODIFY COLUMN Output String CODEC(ZSTD(3));`;
      const result = validateContent(sql, 'clickhouse');

      // First MODIFY_COLUMN is suppressed, second is NOT (comment is 2 lines away)
      expect(result.violations.filter((v) => v.rule.id === 'MODIFY_COLUMN')).toHaveLength(1);
    });
  });

  describe('Edge Cases', () => {
    describe('Known limitations', () => {
      it('KNOWN LIMITATION: flags DROP TABLE in SQL comments (regex-based, not AST)', () => {
        const sql = `
          -- DROP TABLE otel_traces; (commented out, should not run)
          ALTER TABLE otel_traces ADD COLUMN new_field String;
        `;
        const result = validateContent(sql, 'clickhouse');

        // This is a known limitation - regex can't distinguish comments from code
        // Document this behavior so users understand the tool's limitations
        expect(result.violations.some((v) => v.rule.id === 'DROP_TABLE')).toBe(true);
      });
    });

    describe('Partial word matching', () => {
      it('should NOT flag partial word matches like "drop" in prose', () => {
        const sql = `
          -- This will drop old data (prose, not SQL command)
          ALTER TABLE otel_traces ADD COLUMN status String;
        `;
        const result = validateContent(sql, 'clickhouse');

        // "will drop old" doesn't match "DROP TABLE" or "DROP COLUMN" patterns
        expect(result.violations.some((v) => v.rule.id === 'DROP_TABLE')).toBe(false);
        expect(result.violations.some((v) => v.rule.id === 'DROP_COLUMN')).toBe(false);
      });
    });

  });

  describe('ClickHouse Edge Cases', () => {
    it('should detect RENAME TABLE direct syntax (not ALTER)', () => {
      const sql = `RENAME TABLE otel_traces TO otel_spans;`;
      const result = validateContent(sql, 'clickhouse');

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.rule.id === 'RENAME_TABLE_DIRECT')).toBe(true);
    });
  });

  describe('Multiple violations', () => {
    it('should detect multiple violations in one file', () => {
      const sql = `
        DROP TABLE otel_old;
        ALTER TABLE otel_traces DROP COLUMN legacy_field;
        ALTER TABLE otel_traces RENAME COLUMN name TO full_name;
        TRUNCATE TABLE otel_logs;
      `;
      const result = validateContent(sql, 'clickhouse');

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(4);
    });

    it('should report correct line numbers', () => {
      const sql = `-- Migration
DROP TABLE otel_traces;
-- Some comment
ALTER TABLE otel_spans DROP COLUMN old_field;`;

      const result = validateContent(sql, 'clickhouse');

      const dropTableViolation = result.violations.find((v) => v.rule.id === 'DROP_TABLE');
      const dropColumnViolation = result.violations.find((v) => v.rule.id === 'DROP_COLUMN');

      expect(dropTableViolation?.line).toBe(2);
      expect(dropColumnViolation?.line).toBe(4);
    });
  });
});
