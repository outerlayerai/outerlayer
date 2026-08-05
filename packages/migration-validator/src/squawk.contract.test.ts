import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

/**
 * Contract tests to verify Squawk catches the violations we care about.
 * These tests ensure our CI will actually catch breaking migrations.
 *
 * Runs in CI only. To run locally: CI=true yarn test
 */

const TMP_DIR = join(tmpdir(), 'squawk-tests');
const IS_CI = process.env.CI === 'true';
const describeCI = IS_CI ? describe : describe.skip;
const require = createRequire(import.meta.url);
const squawkPackageJsonPath = require.resolve('squawk-cli/package.json');
const SQUAWK_BIN = join(dirname(squawkPackageJsonPath), 'js', 'bin', 'squawk');

function runSquawk(sql: string): { exitCode: number; output: string } {
  const filePath = join(TMP_DIR, `${randomUUID()}.sql`);
  writeFileSync(filePath, sql);

  try {
    const output = execFileSync(SQUAWK_BIN, [filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (existsSync(filePath)) unlinkSync(filePath);
    return { exitCode: 0, output };
  } catch (error: unknown) {
    if (existsSync(filePath)) unlinkSync(filePath);
    const execError = error as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: execError.status ?? 1,
      output: (execError.stdout ?? '') + (execError.stderr ?? ''),
    };
  }
}

describeCI('Squawk Contract Tests', { timeout: 30000 }, () => {
  beforeAll(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    if (!existsSync(SQUAWK_BIN)) {
      throw new Error(`Expected Squawk binary at ${SQUAWK_BIN}`);
    }
  });

  describe('Must catch these violations (expand-contract)', () => {
    it('should catch DROP COLUMN (ban-drop-column)', () => {
      const result = runSquawk('ALTER TABLE users DROP COLUMN email;');

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toMatch(/ban-drop-column/i);
    });

    it('should catch RENAME COLUMN (renaming-column)', () => {
      const result = runSquawk('ALTER TABLE users RENAME COLUMN email TO email_address;');

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toMatch(/renaming-column/i);
    });

    it('should catch RENAME TABLE (renaming-table)', () => {
      const result = runSquawk('ALTER TABLE users RENAME TO customers;');

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toMatch(/renaming-table/i);
    });

    it('should catch ADD NOT NULL without DEFAULT (adding-required-field)', () => {
      const result = runSquawk('ALTER TABLE users ADD COLUMN phone TEXT NOT NULL;');

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toMatch(/adding-required-field/i);
    });

    it('should catch changing column type (changing-column-type)', () => {
      const result = runSquawk('ALTER TABLE users ALTER COLUMN age TYPE bigint;');

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toMatch(/changing-column-type/i);
    });
  });

  describe('Should allow safe operations', () => {
    // Squawk may emit warnings (require-timeout-settings, prefer-robust-stmts) that cause
    // non-zero exit codes. We check that no BREAKING migration rules are triggered.
    const BREAKING_RULES = /ban-drop-column|renaming-column|renaming-table|adding-required-field|changing-column-type/i;

    // Ensure Squawk actually ran (not a silent failure)
    function assertSquawkRan(output: string) {
      expect(output).toMatch(/Found \d+ issues|checked \d+ source file/i);
    }

    it('should allow CREATE TABLE', () => {
      const result = runSquawk(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL
        );
      `);

      assertSquawkRan(result.output);
      expect(result.output).not.toMatch(BREAKING_RULES);
    });

    it('should allow ADD nullable COLUMN', () => {
      const result = runSquawk('ALTER TABLE users ADD COLUMN phone TEXT;');

      assertSquawkRan(result.output);
      expect(result.output).not.toMatch(BREAKING_RULES);
    });

    it('should allow ADD COLUMN with DEFAULT', () => {
      const result = runSquawk("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");

      assertSquawkRan(result.output);
      expect(result.output).not.toMatch(BREAKING_RULES);
    });
  });
});
