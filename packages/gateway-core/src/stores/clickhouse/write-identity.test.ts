import { describe, it, expect } from 'vitest';
import { clickHouseWriteAuth } from './write-identity';

describe('clickHouseWriteAuth', () => {
  it('authenticates as the write user with its own password when configured', () => {
    expect(
      clickHouseWriteAuth({
        CLICKHOUSE_PASSWORD: 'default-superuser-pw',
        CLICKHOUSE_WRITE_USER: 'analytics_writer',
        CLICKHOUSE_WRITE_PASSWORD: 'writer-pw',
      }),
    ).toEqual({ username: 'analytics_writer', password: 'writer-pw' });
  });

  it('never leaks the default password to the write user when its own is unset', () => {
    // A missing write password must NOT silently fall through to
    // CLICKHOUSE_PASSWORD (the default superuser's) — that would auth the
    // write user against the wrong secret. It coalesces to empty instead.
    expect(
      clickHouseWriteAuth({
        CLICKHOUSE_PASSWORD: 'default-superuser-pw',
        CLICKHOUSE_WRITE_USER: 'analytics_writer',
      }),
    ).toEqual({ username: 'analytics_writer', password: '' });
  });

  it('falls back to the default identity with NO username key when the write user is unset', () => {
    const result = clickHouseWriteAuth({ CLICKHOUSE_PASSWORD: 'default-superuser-pw' });
    // `username` must be absent, not present-and-undefined: spreading an explicit
    // `username: undefined` into createClient would override the client's own
    // `default` default. The key must be absent, not undefined.
    expect(result).toEqual({ password: 'default-superuser-pw' });
    expect('username' in result).toBe(false);
  });

  it('yields an empty password (not undefined) when nothing is configured', () => {
    // The integration-tests / bare-self-host case: `default` with no password.
    const result = clickHouseWriteAuth({});
    expect(result).toEqual({ password: '' });
    expect('username' in result).toBe(false);
  });
});
