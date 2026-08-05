import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  makePreTenantAction,
  type PreTenantActor,
  type ResolvePreTenantActor,
} from './pre-tenant-action';
import { ActionErrorCodes } from './result';

const schema = z.object({ name: z.string().min(1) });

const RAW_USER = { id: 'user-1', email: 'a@b.c' };
const ACTOR: PreTenantActor = { userId: 'user-1', email: 'a@b.c', raw: RAW_USER };

function makeDeps(actor: PreTenantActor | null = ACTOR) {
  const resolveActor = vi.fn<ResolvePreTenantActor>(async () => actor);
  return { resolveActor };
}

describe('preTenantAction', () => {
  it('validates, resolves the actor, then calls the handler with (actor, parsedInput) and returns ok(data)', async () => {
    const handler = vi.fn(async (_actor: PreTenantActor, input: { name: string }) => ({
      id: 'o1',
      name: input.name,
    }));
    const deps = makeDeps();
    const action = makePreTenantAction(deps)({
      input: schema,
      reason: 'no-tenant-yet',
      handler,
    });

    // Extra key is stripped by zod; handler must see only the parsed shape.
    const result = await action({ name: 'acme', extra: 'dropped' });

    expect(handler).toHaveBeenCalledWith(ACTOR, { name: 'acme' });
    expect(result).toEqual({ ok: true, data: { id: 'o1', name: 'acme' } });
  });

  it('returns unauthenticated and never calls the handler when the actor seam resolves null', async () => {
    const handler = vi.fn();
    const deps = makeDeps(null);
    const action = makePreTenantAction(deps)({
      input: schema,
      reason: 'no-tenant-yet',
      handler,
    });

    const result = await action({ name: 'acme' });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.UNAUTHENTICATED, message: 'Not authenticated' },
    });
  });

  it('rejects invalid input with fieldErrors and never resolves the actor seam', async () => {
    const handler = vi.fn();
    const deps = makeDeps();
    const action = makePreTenantAction(deps)({
      input: schema,
      reason: 'no-tenant-yet',
      handler,
    });

    const result = await action({ name: '' });

    expect(deps.resolveActor).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe(ActionErrorCodes.VALIDATION);
    expect(result.error.fieldErrors?.name).toHaveLength(1);
  });

  it('maps a thrown handler error to an internal failure — no exception leaks', async () => {
    const handler = vi.fn(async () => {
      throw new Error('service exploded');
    });
    const deps = makeDeps();
    const action = makePreTenantAction(deps)({
      input: schema,
      reason: 'no-tenant-yet',
      handler,
    });

    const result = await action({ name: 'acme' });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.INTERNAL, message: 'service exploded' },
    });
  });

  it('the actor the handler receives has no db and no tenantId — only userId, email, raw', async () => {
    let received: PreTenantActor | undefined;
    const handler = vi.fn((actor: PreTenantActor) => {
      received = actor;
      return { ok: true };
    });
    const deps = makeDeps();
    const action = makePreTenantAction(deps)({
      input: schema,
      reason: 'no-tenant-yet',
      handler,
    });

    await action({ name: 'acme' });

    expect(Object.keys(received as object).sort()).toEqual(['email', 'raw', 'userId']);
  });
});
