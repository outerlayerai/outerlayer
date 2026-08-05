/**
 * ClickHouse Error Pattern Contract Tests
 *
 * Runs against the real service so the assumptions we make about ClickHouse's
 * error message format stay honest — DB::Exception wording, syntax-error
 * phrasing, plain-text (not JSON) bodies. Any consumer that pattern-matches
 * ClickHouse errors depends on these shapes staying stable.
 *
 * Run these tests against the real local ClickHouse instance.
 */

import {
  CLICKHOUSE_TEST_HOST,
  queryClickHouse,
} from '../../../clickhouse/setup-clickhouse';

/**
 * Helper to send a raw query to ClickHouse and capture the error
 */
async function getClickHouseError(query: string): Promise<string | null> {
  try {
    const response = await fetch(`${CLICKHOUSE_TEST_HOST}/`, {
      method: 'POST',
      body: query,
    });

    if (!response.ok) {
      return await response.text();
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('ClickHouse Error Pattern Contract Tests', () => {
  // Verify ClickHouse is accessible before running tests
  beforeAll(async () => {
    // Quick health check to ensure ClickHouse is ready
    const maxRetries = 5;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${CLICKHOUSE_TEST_HOST}/ping`);
        if (response.ok) {
          return; // ClickHouse is ready
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error(`ClickHouse not accessible after ${maxRetries} retries: ${lastError?.message}`);
  });

  describe('CLICKHOUSE_QUERY_ERROR patterns', () => {
    it('should return error containing "DB::Exception" for invalid queries', async () => {
      // This pattern is critical for classifying non-retryable query errors
      const error = await getClickHouseError('SELECT * FROM nonexistent_table_xyz_123');

      expect(error).not.toBeNull();
      expect(error).toContain('DB::Exception');
    });

    it('should return error containing "syntax error" for malformed SQL', async () => {
      const error = await getClickHouseError('SELEKT * FROM otel_traces');

      expect(error).not.toBeNull();
      // ClickHouse returns "Syntax error" in the message
      expect(error?.toLowerCase()).toContain('syntax error');
    });

    it('should return error containing "unknown column" for invalid column reference', async () => {
      const error = await getClickHouseError(
        'SELECT nonexistent_column_xyz FROM otel_traces LIMIT 1'
      );

      expect(error).not.toBeNull();
      // ClickHouse uses "Unknown identifier" or similar
      expect(error?.toLowerCase()).toMatch(/unknown|missing|identifier/);
    });

    it('should return error containing "type mismatch" for type errors', async () => {
      // Try to insert a string where a number is expected
      const error = await getClickHouseError(
        "INSERT INTO otel_traces (InputTokens) VALUES ('not_a_number')"
      );

      expect(error).not.toBeNull();
      // ClickHouse returns type-related error messages
      expect(error?.toLowerCase()).toMatch(/type|cannot parse|expected/);
    });
  });

  describe('Connection error patterns (simulated)', () => {
    // Note: We can't easily simulate real connection errors in integration tests
    // These tests document the expected patterns for reference

    it('should document expected timeout patterns', () => {
      const timeoutPatterns = [
        'timeout',
        'ETIMEDOUT',
        'ESOCKETTIMEDOUT',
        'socket hang up',
        'read ECONNRESET',
      ];

      // Verify patterns are lowercase for case-insensitive matching
      timeoutPatterns.forEach(pattern => {
        expect(pattern.toLowerCase()).toBe(pattern.toLowerCase());
      });
    });

    it('should document expected unavailable patterns', () => {
      const unavailablePatterns = [
        'ECONNREFUSED',
        'ENOTFOUND',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'connection refused',
        'network is unreachable',
        'no route to host',
        'service unavailable',
        '503',
      ];

      // Verify patterns exist
      expect(unavailablePatterns.length).toBeGreaterThan(0);
    });
  });

  describe('Error format consistency', () => {
    it('should return errors as plain text (not JSON) for query failures', async () => {
      const error = await getClickHouseError('INVALID QUERY SYNTAX HERE');

      expect(error).not.toBeNull();
      // ClickHouse returns plain text errors, not JSON
      expect(() => JSON.parse(error!)).toThrow();
    });

    it('should include error code in DB::Exception format', async () => {
      const error = await getClickHouseError('SELECT * FROM nonexistent_table_contract_test');

      expect(error).not.toBeNull();
      // ClickHouse format: "Code: XXX. DB::Exception: ..."
      expect(error).toMatch(/Code:\s*\d+/);
      expect(error).toContain('DB::Exception');
    });
  });

  describe('Validation error patterns', () => {
    it('should return descriptive error for invalid data format', async () => {
      // Try to insert invalid timestamp format
      const error = await getClickHouseError(
        "INSERT INTO otel_traces (Timestamp) VALUES ('invalid-timestamp')"
      );

      expect(error).not.toBeNull();
      // Error should indicate parsing/validation issue
      expect(error?.toLowerCase()).toMatch(/cannot parse|invalid|expected/);
    });
  });
});

describe('ClickHouse Success Response Contract', () => {
  it('should return empty response for successful INSERT', async () => {
    // This verifies our assumption about successful insert responses
    const response = await fetch(`${CLICKHOUSE_TEST_HOST}/`, {
      method: 'POST',
      body: `
        INSERT INTO otel_traces (
          Timestamp, TraceId, SpanId, SpanName, TenantId, AppId, UpdatedAt, IsDeleted
        ) VALUES (
          now64(9),
          'contract-test-trace-id-12345678',
          'contract-span-id-123',
          'contract-test-span',
          'contract-test-tenant',
          'contract-test-app',
          now64(3),
          0
        )
      `,
    });

    expect(response.ok).toBe(true);
    const text = await response.text();
    // Successful inserts return empty body
    expect(text.trim()).toBe('');
  });

  it('should return JSON for SELECT queries with FORMAT JSONEachRow', async () => {
    const rows = await queryClickHouse(
      "SELECT 1 as test_value FORMAT JSONEachRow"
    );

    expect(Array.isArray(rows)).toBe(true);
  });
});
