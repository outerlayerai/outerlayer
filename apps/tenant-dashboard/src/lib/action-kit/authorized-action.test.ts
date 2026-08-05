import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  makeAuthorizedAction,
  ActionErrorCodes,
  ActionForbiddenError,
  type PermissionChecker,
} from './authorized-action';
import type { Actor, ServiceContext } from './service-context';

const schema = z.object({ name: z.string().min(1) });

const CTX: ServiceContext = {
  db: { from: () => ({}) },
  tenantId: 'tenant-1',
  actor: { userId: 'user-1', role: 'admin' },
};

function makeDeps(check: PermissionChecker['check'] = async () => true) {
  const resolveContext = vi.fn<() => Promise<ServiceContext>>(async () => CTX);
  const checkFn = vi.fn<(actor: Actor, permission: string, appId?: string) => Promise<boolean>>(
    check as (actor: Actor, permission: string, appId?: string) => Promise<boolean>,
  );
  return { resolveContext, permissions: { check: checkFn } };
}

describe('authorizedAction', () => {
  it('validates, authorizes, then calls the handler with (ctx, parsedInput) and returns ok(data)', async () => {
    const handler = vi.fn(async (_ctx: ServiceContext, input: { name: string }) => ({
      id: 'k1',
      name: input.name,
    }));
    const deps = makeDeps();
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_INSERT',
      handler,
    });

    // Extra key is stripped by zod; handler must see only the parsed shape.
    const result = await action({ name: 'prod', extra: 'dropped' });

    expect(handler).toHaveBeenCalledWith(CTX, { name: 'prod' });
    // No config.appId ⇒ the app-scope argument is undefined (org-scoped check).
    expect(deps.permissions.check).toHaveBeenCalledWith(CTX.actor, 'API_KEY_INSERT', undefined);
    expect(result).toStrictEqual({ ok: true, data: { id: 'k1', name: 'prod' } });
  });

  it('threads the target app id from the parsed input into an app-scoped check', async () => {
    const appSchema = z.object({ appId: z.string(), name: z.string() });
    const handler = vi.fn(async () => ({ ok: true }));
    const deps = makeDeps();
    const action = makeAuthorizedAction(deps)({
      input: appSchema,
      permission: 'app_policy.update',
      appId: (input) => input.appId,
      handler,
    });

    await action({ appId: 'app-9', name: 'prod' });

    expect(deps.permissions.check).toHaveBeenCalledWith(CTX.actor, 'app_policy.update', 'app-9');
  });

  it('rejects invalid input with fieldErrors and never resolves context or calls the handler', async () => {
    const handler = vi.fn();
    const deps = makeDeps();
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_INSERT',
      handler,
    });

    const result = await action({ name: '' });

    expect(handler).not.toHaveBeenCalled();
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.permissions.check).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe(ActionErrorCodes.VALIDATION);
    expect(result.error.fieldErrors?.name).toHaveLength(1);
  });

  it('a denial without onDenied is unchanged', async () => {
    const handler = vi.fn();
    const deps = makeDeps(async () => false);
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_DELETE',
      handler,
    });

    const result = await action({ name: 'prod' });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: API_KEY_DELETE' },
    });
  });

  it('onDenied fires once with parsed input plus the resolved tenant/actor id, and the handler never runs', async () => {
    const handler = vi.fn();
    const onDenied = vi.fn();
    const deps = makeDeps(async () => false);
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_DELETE',
      onDenied,
      handler,
    });

    // Raw input carries an extra key zod strips, so a pass-through of the raw
    // argument (instead of the parsed one) would fail this assertion.
    const result = await action({ name: 'prod', extra: 'dropped' });

    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied).toHaveBeenCalledWith({ name: 'prod' }, { tenantId: 'tenant-1', actorId: 'user-1' });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: API_KEY_DELETE' },
    });
  });

  it('onDenied receives ONLY identifiers, never a db client — an exact-shape match so a widened payload fails this test', async () => {
    let receivedDenied: unknown;
    const onDenied = vi.fn((_input: { name: string }, denied: unknown) => {
      receivedDenied = denied;
    });
    const deps = makeDeps(async () => false);
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_DELETE',
      onDenied,
      handler: vi.fn(),
    });

    await action({ name: 'prod' });

    // Exact key set: {tenantId, actorId} only. Object.keys pins the shape —
    // toEqual alone would still pass if a `db`/`ctx` field were added.
    expect(Object.keys(receivedDenied as object).sort()).toEqual(['actorId', 'tenantId']);
    expect(receivedDenied).toStrictEqual({ tenantId: 'tenant-1', actorId: 'user-1' });
  });

  it('onDenied does not fire on success', async () => {
    const handler = vi.fn(async () => ({ id: 'k1' }));
    const onDenied = vi.fn();
    const deps = makeDeps(async () => true);
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_INSERT',
      onDenied,
      handler,
    });

    await action({ name: 'prod' });

    expect(onDenied).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('onDenied does not fire on a validation failure', async () => {
    const handler = vi.fn();
    const onDenied = vi.fn();
    const deps = makeDeps();
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_INSERT',
      onDenied,
      handler,
    });

    const result = await action({ name: '' });

    expect(onDenied).not.toHaveBeenCalled();
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.permissions.check).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('a throwing onDenied cannot turn a denial into a server error', async () => {
    const handler = vi.fn();
    const onDenied = vi.fn(async () => {
      throw new Error('audit sink unavailable');
    });
    const deps = makeDeps(async () => false);
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_DELETE',
      onDenied,
      handler,
    });

    const result = await action({ name: 'prod' });

    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Permission denied: API_KEY_DELETE' },
    });
  });

  it('a mid-handler forbidden does not trigger the denial hook', async () => {
    const onDenied = vi.fn();
    const handler = vi.fn(async () => {
      throw new ActionForbiddenError('Custom metrics require a Growth plan or higher.');
    });
    const deps = makeDeps(async () => true);
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_INSERT',
      onDenied,
      handler,
    });

    const result = await action({ name: 'prod' });

    expect(onDenied).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Custom metrics require a Growth plan or higher.' },
    });
  });

  it('maps a thrown handler error to an internal failure — no exception leaks', async () => {
    const handler = vi.fn(async () => {
      throw new Error('db exploded');
    });
    const deps = makeDeps();
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_INSERT',
      handler,
    });

    const result = await action({ name: 'prod' });

    expect(result).toStrictEqual({
      ok: false,
      error: { code: ActionErrorCodes.INTERNAL, message: 'db exploded' },
    });
  });

  it('maps a thrown ActionForbiddenError to the forbidden code, not internal — an authorization-class denial discovered mid-handler', async () => {
    const handler = vi.fn(async () => {
      throw new ActionForbiddenError('Custom metrics require a Growth plan or higher.');
    });
    const deps = makeDeps();
    const action = makeAuthorizedAction(deps)({
      input: schema,
      permission: 'API_KEY_INSERT',
      handler,
    });

    const result = await action({ name: 'prod' });

    expect(result).toStrictEqual({
      ok: false,
      error: { code: ActionErrorCodes.FORBIDDEN, message: 'Custom metrics require a Growth plan or higher.' },
    });
  });
});
