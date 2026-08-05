import { describe, it, expect, vi } from 'vitest';
import { mintApiKey } from './mint-key';
import { hashApiKey } from './crypto';

// ---------------------------------------------------------------------------
// Fake Supabase clients. We record every call in order so the delete→insert
// sequencing and the rollback path are assertable positionally. The chain
// mirrors supabase-js: filter builders are thenable and each .eq returns self.
// ---------------------------------------------------------------------------

interface Recorder {
  ops: Array<{ op: string; table?: string; payload?: unknown; eqs?: Array<[string, unknown]> }>;
}

function makeClient(opts: {
  insertResult?: { data: unknown; error: unknown };
  deleteResult?: { error: unknown };
  rpcResult?: { error: unknown };
  recorder: Recorder;
}) {
  const { recorder } = opts;
  const insertResult = opts.insertResult ?? { data: { id: 'row-id-1', api_key_id: 'key_abc' }, error: null };
  const deleteResult = opts.deleteResult ?? { error: null };
  const rpcResult = opts.rpcResult ?? { error: null };

  return {
    from(table: string) {
      return {
        delete() {
          const record = { op: 'delete', table, eqs: [] as Array<[string, unknown]> };
          recorder.ops.push(record);
          const chain: any = {
            eq(col: string, val: unknown) {
              record.eqs.push([col, val]);
              return chain;
            },
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
              return Promise.resolve(deleteResult).then(onF, onR);
            },
          };
          return chain;
        },
        insert(payload: unknown) {
          recorder.ops.push({ op: 'insert', table, payload });
          return {
            select() {
              return {
                single() {
                  return Promise.resolve(insertResult);
                },
              };
            },
          };
        },
      };
    },
    rpc: vi.fn(async (fn: string, args: unknown) => {
      recorder.ops.push({ op: 'rpc', table: fn, payload: args });
      return rpcResult;
    }),
  };
}

const BASE = {
  pepper: 'test-pepper-value',
  tenantId: 'tenant-1',
  appId: 'app-1',
  name: 'CI Pipeline',
  permissions: ['trace.write'],
  allowedEnvKinds: ['development', 'preview'],
};

describe('mintApiKey', () => {
  it('inserts the row with the full expected column set, then sets the secret', async () => {
    const recorder: Recorder = { ops: [] };
    const client = makeClient({ recorder });

    const result = await mintApiKey({
      rowClient: client,
      adminClient: client,
      ...BASE,
      environmentId: 'env-1',
      expiresAt: null,
    });

    // Row insert carries every column with the caller's values.
    const insertOp = recorder.ops.find((o) => o.op === 'insert');
    expect(insertOp?.payload).toEqual(
      expect.objectContaining({
        name: 'CI Pipeline',
        tenant_id: 'tenant-1',
        app_id: 'app-1',
        environment_id: 'env-1',
        allowed_env_kinds: ['development', 'preview'],
        permissions: ['trace.write'],
        expires_at: null,
        is_machine: false,
        api_key_id: expect.stringMatching(/^key_[0-9a-f]{24}$/),
        key_prefix: expect.stringMatching(/^sk_outerlayer_/),
      }),
    );
    // No created_by when the caller omits it (trigger stamps auth.uid()).
    expect(insertOp?.payload).not.toHaveProperty('created_by');
    expect(result.row).toEqual({ id: 'row-id-1', api_key_id: 'key_abc' });
  });

  it('passes a concrete expires_at through to the row unchanged', async () => {
    const recorder: Recorder = { ops: [] };
    const client = makeClient({ recorder });

    await mintApiKey({
      rowClient: client,
      adminClient: client,
      ...BASE,
      environmentId: 'env-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    const insertOp = recorder.ops.find((o) => o.op === 'insert');
    expect((insertOp?.payload as Record<string, unknown>).expires_at).toBe(
      '2030-01-01T00:00:00.000Z',
    );
  });

  it('stores the digest of the EXACT plaintext it returns (ties secret to row)', async () => {
    const recorder: Recorder = { ops: [] };
    const client = makeClient({ recorder });

    const result = await mintApiKey({
      rowClient: client,
      adminClient: client,
      ...BASE,
      environmentId: 'env-1',
    });

    const rpcOp = recorder.ops.find((o) => o.op === 'rpc');
    expect(rpcOp?.table).toBe('set_api_key_secret');
    const expectedDigest = await hashApiKey(result.plaintext, BASE.pepper);
    expect(rpcOp?.payload).toEqual({
      p_api_key_id: 'row-id-1',
      p_key_digest: expectedDigest,
      p_pepper_version: 1,
    });
  });

  it('orders delete → insert → rpc when replaceExisting is set', async () => {
    const recorder: Recorder = { ops: [] };
    const client = makeClient({ recorder });

    await mintApiKey({
      rowClient: client,
      adminClient: client,
      ...BASE,
      environmentId: 'env-1',
      replaceExisting: true,
    });

    expect(recorder.ops.map((o) => o.op)).toEqual(['delete', 'insert', 'rpc']);
    const deleteOp = recorder.ops[0]!;
    expect(deleteOp.table).toBe('api_key');
    expect(deleteOp.eqs).toEqual([
      ['name', 'CI Pipeline'],
      ['app_id', 'app-1'],
    ]);
  });

  it('does not delete first when replaceExisting is absent', async () => {
    const recorder: Recorder = { ops: [] };
    const client = makeClient({ recorder });

    await mintApiKey({
      rowClient: client,
      adminClient: client,
      ...BASE,
      environmentId: 'env-1',
    });

    expect(recorder.ops.map((o) => o.op)).toEqual(['insert', 'rpc']);
  });

  it('sets created_by explicitly when passed (incl. null for machine keys)', async () => {
    const recorder: Recorder = { ops: [] };
    const client = makeClient({ recorder });

    await mintApiKey({
      rowClient: client,
      adminClient: client,
      ...BASE,
      environmentId: 'env-1',
      isMachine: true,
      createdBy: null,
    });

    const insertOp = recorder.ops.find((o) => o.op === 'insert');
    expect((insertOp?.payload as Record<string, unknown>).created_by).toBeNull();
    expect((insertOp?.payload as Record<string, unknown>).is_machine).toBe(true);
  });

  it('rolls the row back (deletes by id) and rethrows when the secret RPC fails', async () => {
    const recorder: Recorder = { ops: [] };
    const rpcError = { message: 'set_api_key_secret failed', code: 'XX000' };
    const client = makeClient({ recorder, rpcResult: { error: rpcError } });

    await expect(
      mintApiKey({
        rowClient: client,
        adminClient: client,
        ...BASE,
        environmentId: 'env-1',
      }),
    ).rejects.toBe(rpcError);

    // insert → rpc(fail) → delete-by-id rollback.
    expect(recorder.ops.map((o) => o.op)).toEqual(['insert', 'rpc', 'delete']);
    const rollback = recorder.ops[2]!;
    expect(rollback.eqs).toEqual([['id', 'row-id-1']]);
  });

  it('surfaces the raw insert error without calling the secret RPC', async () => {
    const recorder: Recorder = { ops: [] };
    const insertError = { message: 'duplicate key', code: '23505' };
    const client = makeClient({ recorder, insertResult: { data: null, error: insertError } });

    await expect(
      mintApiKey({
        rowClient: client,
        adminClient: client,
        ...BASE,
        environmentId: 'env-1',
      }),
    ).rejects.toBe(insertError);

    expect(recorder.ops.some((o) => o.op === 'rpc')).toBe(false);
  });

  it('surfaces the raw delete error and never inserts when replace delete fails', async () => {
    const recorder: Recorder = { ops: [] };
    const deleteError = { message: 'delete blocked', code: 'XXXXX' };
    const client = makeClient({ recorder, deleteResult: { error: deleteError } });

    await expect(
      mintApiKey({
        rowClient: client,
        adminClient: client,
        ...BASE,
        environmentId: 'env-1',
        replaceExisting: true,
      }),
    ).rejects.toBe(deleteError);

    expect(recorder.ops.map((o) => o.op)).toEqual(['delete']);
  });
});
