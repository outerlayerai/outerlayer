import { beforeEach, describe, expect, it, vi } from 'vitest';

// Both seams are plain FUNCTIONS, not Supabase clients — `listAppEnvironments`
// exists precisely so the admin-client read lives behind a named helper rather
// than inlined here (see lib/system-client.ts). That is what makes the dispatch
// below testable without standing up a query builder.
const { mockListAppEnvironments, mockResolveEnvironmentFromApiKey } = vi.hoisted(() => ({
  mockListAppEnvironments: vi.fn(),
  mockResolveEnvironmentFromApiKey: vi.fn(),
}));

vi.mock('../../lib/system-client', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  listAppEnvironments: mockListAppEnvironments,
  // The pinned-env branch builds an admin client before delegating to the
  // (mocked) resolver. Stubbed to an empty object so no real Supabase client is
  // constructed — the resolver never touches it here.
  createSystemAdminClient: () => ({}),
  asServiceClient: (x: unknown) => x,
}));
vi.mock('../../lib/environment-resolver', () => ({
  resolveEnvironmentFromApiKey: mockResolveEnvironmentFromApiKey,
}));

import { kindScopeFromRows, resolveEnvScope, type EnvKindRow } from '../routes/_shared';
import type { AppContext } from '../routes/_shared';

/**
 * A KIND-scoped API key ("Preview only") stores `environment_id IS NULL` and
 * carries `allowedEnvKinds` instead. The read path has to resolve those kinds
 * itself: the pinned-env resolver takes its row-absent branch for such a key and
 * yields the NO_ENVIRONMENT sentinel, which `resolveEnvScope` would otherwise
 * turn into `undefined` — no env filter, and the key reads every environment of
 * its app.
 *
 * `kindScopeFromRows` is the decision, separated from the query that feeds it, so
 * the two properties that matter are testable directly: which environments a set
 * of kinds admits, and what happens when it admits none.
 *
 * `EnvTargetKind` is `development | preview | promoted`:
 *   ephemeral                    → preview
 *   current_version > 0 (pinned) → promoted
 *   otherwise                    → development
 */

const PREVIEW: EnvKindRow = { name: 'pr-42', current_version: 0, is_ephemeral: true };
const PROMOTED: EnvKindRow = { name: 'prod', current_version: 7, is_ephemeral: false };
const DEVELOPMENT: EnvKindRow = { name: 'dev', current_version: 0, is_ephemeral: false };
const ALL_ROWS = [PREVIEW, PROMOTED, DEVELOPMENT];

describe('kindScopeFromRows', () => {
  it('admits only the environments whose kind is allowed', () => {
    expect(kindScopeFromRows(ALL_ROWS, ['preview'])).toEqual({ environments: ['pr-42'] });
  });

  it.each([
    [['promoted'], ['prod']],
    [['development'], ['dev']],
    [['preview', 'promoted'], ['pr-42', 'prod']],
    [['development', 'preview', 'promoted'], ['pr-42', 'prod', 'dev']],
  ])('maps kinds %j to environments %j', (kinds, expected) => {
    expect(kindScopeFromRows(ALL_ROWS, kinds)).toEqual({ environments: expected });
  });

  it('fails CLOSED — an empty allow-list, never "no filter" — when no kind matches', () => {
    // `undefined` here would read as "no env filter" to every caller
    // downstream. An empty array is a distinct instruction that
    // buildEnvironmentWhereClause compiles to a false predicate.
    expect(kindScopeFromRows([PROMOTED], ['preview'])).toEqual({ environments: [] });
  });

  it('fails CLOSED when the app has no environments at all', () => {
    expect(kindScopeFromRows([], ['preview'])).toEqual({ environments: [] });
  });

  it('fails CLOSED for an unrecognised kind rather than admitting everything', () => {
    expect(kindScopeFromRows(ALL_ROWS, ['not-a-kind'])).toEqual({ environments: [] });
  });

  it('skips rows with no usable name instead of emitting a blank env filter', () => {
    // A blank name in the IN-list would match rows stamped `Environment = ''`,
    // which is the legacy/pre-feature bucket — a different env's data.
    expect(
      kindScopeFromRows(
        [{ name: null, current_version: 0, is_ephemeral: true }, PREVIEW],
        ['preview'],
      ),
    ).toEqual({ environments: ['pr-42'] });
    expect(
      kindScopeFromRows([{ name: '', current_version: 0, is_ephemeral: true }], ['preview']),
    ).toEqual({ environments: [] });
  });

  it('treats a null current_version as unpinned (development), not promoted', () => {
    expect(
      kindScopeFromRows(
        [{ name: 'dev', current_version: null, is_ephemeral: false }],
        ['development'],
      ),
    ).toEqual({ environments: ['dev'] });
  });

  it('classifies an ephemeral env as preview even when it is pinned', () => {
    // preview WINS over promoted in classifyEnvKind; pin the precedence so a
    // reordering there shows up here rather than as a silent scope widening.
    const pinnedEphemeral: EnvKindRow = { name: 'pr-9', current_version: 3, is_ephemeral: true };
    expect(kindScopeFromRows([pinnedEphemeral], ['preview'])).toEqual({
      environments: ['pr-9'],
    });
    expect(kindScopeFromRows([pinnedEphemeral], ['promoted'])).toEqual({ environments: [] });
  });
});


/**
 * The dispatch in `resolveEnvScope`: which of the three shapes a request takes.
 * A kind-scoped key must not fall through to the pinned-env resolver — that
 * finds nothing and returns `undefined`, which every caller reads as "no env
 * filter".
 */
describe('resolveEnvScope dispatch', () => {
  const ctxWith = (user: Record<string, unknown>): AppContext =>
    ({ get: (k: string) => (k === 'user' ? user : undefined), env: {} }) as unknown as AppContext;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('takes the KIND branch when the key carries allowed kinds', async () => {
    mockListAppEnvironments.mockResolvedValue([PREVIEW, PROMOTED]);

    const scope = await resolveEnvScope(
      ctxWith({ apiKeyId: 'k', tenantId: 't', appId: 'a', allowedEnvKinds: ['preview'] }),
    );

    expect(scope).toEqual({ environments: ['pr-42'] });
    expect(mockListAppEnvironments).toHaveBeenCalledWith({}, 't', 'a');
    // The pinned-env resolver is never consulted — there is no pinned env.
    expect(mockResolveEnvironmentFromApiKey).not.toHaveBeenCalled();
  });

  it('propagates a lookup failure instead of degrading to no filter', async () => {
    mockListAppEnvironments.mockRejectedValue(new Error('environment kind resolution failed'));

    await expect(
      resolveEnvScope(
        ctxWith({ apiKeyId: 'k', tenantId: 't', appId: 'a', allowedEnvKinds: ['preview'] }),
      ),
    ).rejects.toThrow('environment kind resolution failed');
  });

  it('takes the PINNED branch when the key has no allowed kinds', async () => {
    mockResolveEnvironmentFromApiKey.mockResolvedValue({
      id: 'env-1',
      name: 'prod',
      isDefault: false,
    });

    const scope = await resolveEnvScope(
      ctxWith({ apiKeyId: 'k', tenantId: 't', appId: 'a', environmentId: 'env-1' }),
    );

    expect(scope).toEqual({
      environment: { name: 'prod', isDefault: false },
      environmentId: 'env-1',
    });
    expect(mockListAppEnvironments).not.toHaveBeenCalled();
  });

  it('treats an EMPTY allowedEnvKinds array as not-kind-scoped', async () => {
    // `[]` here means the key is not kind-scoped at all, which is different from
    // a kind-scoped key that resolves to no environments (that returns an empty
    // allow-list, not undefined).
    mockResolveEnvironmentFromApiKey.mockResolvedValue({
      id: 'env-1',
      name: 'dev',
      isDefault: true,
    });

    const scope = await resolveEnvScope(
      ctxWith({ apiKeyId: 'k', tenantId: 't', appId: 'a', allowedEnvKinds: [] }),
    );

    expect(scope).toEqual({
      environment: { name: 'dev', isDefault: true },
      environmentId: 'env-1',
    });
    expect(mockListAppEnvironments).not.toHaveBeenCalled();
  });

  it('returns undefined for bearer auth — there is no key to scope by', async () => {
    expect(await resolveEnvScope(ctxWith({ tenantId: 't', appId: 'a' }))).toBeUndefined();
    expect(mockListAppEnvironments).not.toHaveBeenCalled();
    expect(mockResolveEnvironmentFromApiKey).not.toHaveBeenCalled();
  });

  it('returns undefined when the pinned resolver finds nothing (legacy key)', async () => {
    mockResolveEnvironmentFromApiKey.mockResolvedValue(null);

    expect(
      await resolveEnvScope(ctxWith({ apiKeyId: 'k', tenantId: 't', appId: 'a' })),
    ).toBeUndefined();
  });
});
