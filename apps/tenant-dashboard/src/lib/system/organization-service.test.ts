/**
 * Tests for OrganizationService — the class that owns multi-tenant org
 * lifecycle: switch, create, invitation-accept, invitation-detail-fetch,
 * and membership-count.
 *
 * Bug classes mutation testing surfaces here:
 *
 *   - LogicalOperator on `membershipError || !membership` — flipped to
 *     `&&` would let a missing-membership query succeed and proceed to
 *     update claims for a user who isn't in the org
 *   - The rollback path on roleClaimError — if it doesn't fire (or fires
 *     with the wrong arg), the user is stranded in a half-switched state
 *   - The Stripe rollback path on RPC failure — without it, every failed
 *     org-create leaves an orphan customer in Stripe (silent revenue
 *     leak on retries)
 *   - Error-message-routing in createOrganization — the unique-violation
 *     branch determines whether the user sees "Organization name is
 *     already taken" vs an opaque stack trace
 *   - The `MAX_ORGANIZATIONS = 10` literal and the `count >= 10` check
 *     boundaries (off-by-one mutations)
 *   - The expires_at branch in acceptInvitation — a stale-but-unexpired
 *     invitation must NOT be marked active
 *
 * Boundary: the class takes its deps in the constructor (supabaseAdmin,
 * supabaseServer, stripeService). Direct seam-mocking is
 * the cleanest assertion surface for this shape — MSW would require
 * building real Supabase clients just to intercept their HTTP calls
 * when the seam itself is already injectable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { OrganizationService } from './organization-service';
import type { StripeService } from '@/lib/adapters';
import { captureActivationEvent } from '@/lib/posthog-server';

// ---------------------------------------------------------------------------
// Mock the serverLogger so its `await` calls don't trip on a missing
// implementation. We only assert on logger calls where the production code
// uses them as a "did this path execute" signal.
// ---------------------------------------------------------------------------
const serverLoggerInfoMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/adapters', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/adapters')>()),
  serverLogger: {
    error: vi.fn().mockResolvedValue(undefined),
    info: serverLoggerInfoMock,
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/posthog-server', () => ({
  captureActivationEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-1';
const ORIGINAL_TENANT_ID = 'tenant-original';
const USER_ID = 'user-1';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    email: 'test@example.com',
    app_metadata: { tenant_id: ORIGINAL_TENANT_ID, role: 'owner' },
    user_metadata: { display_name: 'Test User' },
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Build a chainable supabase mock. The chain itself is the same object
 * every call — terminal `.single()` reads from a queued list, and
 * count-style `.select(..., { count: 'exact', head: true }).eq(...).eq(...)`
 * resolves via a thenable on the chain.
 */
function makeSupabaseMock() {
  const singleQueue: Array<{ data: unknown; error: unknown }> = [];
  const countQueue: Array<{ count: number | null; error: unknown }> = [];
  const updateResultQueue: Array<{ data: unknown; error: unknown }> = [];
  const rpcResponses = new Map<string, { data: unknown; error: unknown }>();
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const single = vi.fn(async () => {
    if (singleQueue.length === 0) {
      throw new Error('makeSupabaseMock: single() called but queue empty');
    }
    return singleQueue.shift()!;
  });

  // `await chain.update().eq(...)` resolves via the thenable below. The
  // chain alternates between select-style (single) and update-style
  // (no .single, just await) calls — track them in a separate queue.
  let nextOperationIsCount = false;
  let nextOperationIsUpdate = false;

  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
      // Detect the count-style select via the second arg.
      if (opts?.count === 'exact' && opts?.head === true) {
        nextOperationIsCount = true;
        nextOperationIsUpdate = false;
      } else if (!nextOperationIsUpdate) {
        // A `.select()` chained AFTER `.delete()`/`.update()` only shapes the
        // returned rows — the pending write still resolves from its queue.
        nextOperationIsCount = false;
      }
      return chain;
    }),
    update: vi.fn(() => {
      nextOperationIsUpdate = true;
      nextOperationIsCount = false;
      return chain;
    }),
    // `.delete()` resolves the same way `.update()` does — a terminal write
    // awaited straight off the chain — so it shares the update queue.
    delete: vi.fn(() => {
      nextOperationIsUpdate = true;
      nextOperationIsCount = false;
      return chain;
    }),
    eq: vi.fn(() => chain),
    single,
    // Thenable: resolves to the next count result (when select-with-count)
    // or update result (when called after .update()).
    then: (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      let promise: Promise<unknown>;
      if (nextOperationIsCount) {
        nextOperationIsCount = false;
        const next = countQueue.shift();
        promise = next
          ? Promise.resolve(next)
          : Promise.reject(new Error('makeSupabaseMock: count queue empty'));
      } else if (nextOperationIsUpdate) {
        nextOperationIsUpdate = false;
        const next = updateResultQueue.shift();
        promise = next
          ? Promise.resolve(next)
          : Promise.reject(new Error('makeSupabaseMock: update queue empty'));
      } else {
        // No specific operation flagged — resolve with empty (catches the
        // case where the chain is awaited without a terminal-style op).
        promise = Promise.resolve({ data: null, error: null });
      }
      return promise.then(resolve, reject);
    },
  });

  const from = vi.fn(() => chain);
  const rpc = vi.fn(async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    if (!rpcResponses.has(name)) {
      throw new Error(`makeSupabaseMock: no rpc response queued for "${name}"`);
    }
    return rpcResponses.get(name)!;
  });

  return {
    client: { from, rpc } as unknown as SupabaseClient,
    queueSingle: (resp: { data: unknown; error: unknown }) => singleQueue.push(resp),
    queueCount: (resp: { count: number | null; error: unknown }) => countQueue.push(resp),
    queueUpdate: (resp: { data: unknown; error: unknown }) => updateResultQueue.push(resp),
    // `.delete()` shares the update queue (see the `delete` chain method above).
    queueDelete: (resp: { data: unknown; error: unknown }) => updateResultQueue.push(resp),
    setRpcResponse: (name: string, resp: { data: unknown; error: unknown }) =>
      rpcResponses.set(name, resp),
    rpc,
    from,
    rpcCalls,
  };
}

function makeMockStripe(): StripeService & {
  createCustomer: ReturnType<typeof vi.fn>;
  deleteCustomer: ReturnType<typeof vi.fn>;
} {
  return {
    createCustomer: vi.fn().mockResolvedValue({ id: 'cus_test' } as Stripe.Customer),
    retrieveCustomer: vi.fn(),
    deleteCustomer: vi.fn().mockResolvedValue(undefined),
    retrieveSubscription: vi.fn(),
    updateSubscription: vi.fn(),
  } as unknown as StripeService & {
    createCustomer: ReturnType<typeof vi.fn>;
    deleteCustomer: ReturnType<typeof vi.fn>;
  };
}

function makeService(overrides?: {
  admin?: ReturnType<typeof makeSupabaseMock>;
  server?: ReturnType<typeof makeSupabaseMock>;
  stripe?: ReturnType<typeof makeMockStripe>;
  billingEnabled?: boolean;
}) {
  const admin = overrides?.admin ?? makeSupabaseMock();
  const server = overrides?.server ?? makeSupabaseMock();
  const stripe = overrides?.stripe ?? makeMockStripe();
  const service = new OrganizationService({
    supabaseAdmin: admin.client,
    supabaseServer: server.client,
    stripeService: stripe,
    billingEnabled: overrides?.billingEnabled,
  });
  return { service, admin, server, stripe };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// setLastActiveOrg
// ===========================================================================

describe('setLastActiveOrg', () => {
  it('writes last_active_tenant_id and issues no set_claim RPC or refreshSession', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: { id: 'm-1', status: 'active' }, error: null });
    admin.queueUpdate({ data: null, error: null });

    const result = await service.setLastActiveOrg({ user: makeUser(), tenantId: TENANT_ID });

    expect(result).toEqual({ success: true, tenantId: TENANT_ID });
    expect(admin.from).toHaveBeenCalledWith('profile');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('returns "Not a member" when membership lookup errors', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: null, error: { message: 'not found' } });

    const result = await service.setLastActiveOrg({ user: makeUser(), tenantId: TENANT_ID });

    expect(result).toEqual({ success: false, error: 'Not a member of this organization' });
    // No preference write should have been attempted.
    expect(admin.from).not.toHaveBeenCalledWith('profile');
  });

  it('returns "Not a member" when membership lookup returns no row', async () => {
    // Catches a LogicalOperator mutation that drops the `!membership`
    // half of the guard — without it, a null-data result would proceed
    // and crash on the write below.
    const { service, admin } = makeService();
    admin.queueSingle({ data: null, error: null });

    const result = await service.setLastActiveOrg({ user: makeUser(), tenantId: TENANT_ID });

    expect(result).toEqual({ success: false, error: 'Not a member of this organization' });
    expect(admin.from).not.toHaveBeenCalledWith('profile');
  });

  it('returns the update error message when the preference write fails', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: { id: 'm-1', status: 'active' }, error: null });
    admin.queueUpdate({ data: null, error: { message: 'pg: forbidden' } });

    const result = await service.setLastActiveOrg({ user: makeUser(), tenantId: TENANT_ID });

    expect(result).toEqual({ success: false, error: 'pg: forbidden' });
  });
});

// ===========================================================================
// createOrganization
// ===========================================================================

describe('createOrganization', () => {
  function setupHappyPath() {
    const ctx = makeService();
    ctx.admin.queueCount({ count: 3, error: null }); // under limit
    ctx.admin.setRpcResponse('create_organization_transaction', {
      data: { tenant_id: 'new-tenant' },
      error: null,
    });
    return ctx;
  }

  it('returns success with tenant_id when all steps succeed', async () => {
    const { service, admin, stripe } = setupHappyPath();

    const result = await service.createOrganization({
      user: makeUser(),
      organizationName: 'My Org',
      companyName: 'Acme',
    });

    expect(result).toEqual({
      success: true,
      tenantId: 'new-tenant',
      organizationName: 'My Org',
    });
    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    // Billing on (hosted): real Stripe customer + the free 'hobby' default tier.
    const txCall = admin.rpcCalls.find(
      (c) => c.name === 'create_organization_transaction',
    );
    expect(txCall?.args).toMatchObject({
      p_stripe_customer_id: 'cus_test',
      p_tier_id: 'hobby',
    });
    expect(captureActivationEvent).toHaveBeenCalledWith(
      'org_provisioned',
      USER_ID,
      'new-tenant',
      { organization_name: 'My Org' },
    );
  });

  it('forwards the user-derived customer name/email/metadata to Stripe', async () => {
    const { service, stripe } = setupHappyPath();
    await service.createOrganization({
      user: makeUser({ user_metadata: { display_name: 'Alice' }, email: 'a@example.com' }),
      organizationName: 'Org-A',
      companyName: 'Co-A',
    });

    expect(stripe.createCustomer).toHaveBeenCalledWith(
      {
        name: 'Alice',
        email: 'a@example.com',
        metadata: expect.objectContaining({
          organizationName: 'Org-A',
          createdBy: USER_ID,
        }),
      },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('skips Stripe and stores a null stripe_customer_id when billing is disabled', async () => {
    // Self-hosting regression: with billing off, org creation must NOT call
    // Stripe and must pass a null customer id to the RPC (the org defaults to
    // the hobby tier). A change that re-introduces the Stripe call — or sends a
    // non-null/'' customer id — would break Stripe-free onboarding.
    const { service, admin, stripe } = makeService({ billingEnabled: false });
    admin.queueCount({ count: 0, error: null }); // under limit
    admin.setRpcResponse('create_organization_transaction', {
      data: { tenant_id: 'new-tenant' },
      error: null,
    });

    const result = await service.createOrganization({
      user: makeUser(),
      organizationName: 'Self Hosted Org',
      companyName: 'Acme',
    });

    expect(result).toEqual({
      success: true,
      tenantId: 'new-tenant',
      organizationName: 'Self Hosted Org',
    });
    // Hard guard: no Stripe customer was provisioned.
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    // The RPC was called with a null customer id (not '' and not a cus_* id)
    // and the enterprise default tier so entitlements resolve unlimited.
    const txCall = admin.rpcCalls.find(
      (c) => c.name === 'create_organization_transaction',
    );
    expect(txCall?.args).toEqual({
      p_user_id: USER_ID,
      p_organization_name: 'Self Hosted Org',
      p_company_name: 'Acme',
      p_stripe_customer_id: null,
      p_tier_id: 'enterprise',
    });
  });

  it('blocks creation when the user is already at the 10-org limit', async () => {
    // Boundary: 10 is the MAX_ORGANIZATIONS constant. A mutation that
    // changes `>=` to `>` would let users sneak in an 11th org.
    const { service, admin, stripe } = makeService();
    admin.queueCount({ count: 10, error: null });

    const result = await service.createOrganization({
      user: makeUser(),
      organizationName: 'Overflow',
      companyName: 'Co',
    });

    expect(result).toEqual({
      success: false,
      error: 'You cannot belong to more than 10 organizations',
    });
    // Hard guard: Stripe was never called.
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it('returns the count-query error message when the membership count fails', async () => {
    const { service, admin, stripe } = makeService();
    admin.queueCount({ count: null, error: { message: 'count query failed' } });

    const result = await service.createOrganization({
      user: makeUser(),
      organizationName: 'X',
      companyName: 'Y',
    });

    expect(result).toEqual({ success: false, error: 'count query failed' });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it('returns a generic billing-setup error when Stripe createCustomer throws', async () => {
    const { service, admin, stripe } = makeService();
    admin.queueCount({ count: 0, error: null });
    stripe.createCustomer.mockRejectedValueOnce(new Error('stripe network down'));

    const result = await service.createOrganization({
      user: makeUser(),
      organizationName: 'X',
      companyName: 'Y',
    });

    expect(result).toEqual({
      success: false,
      error: 'Failed to set up billing. Please try again.',
    });
  });

  it('ROLLS BACK the Stripe customer and surfaces "already taken" on unique-violation', async () => {
    // 23505 → user-visible "Organization name is already taken".
    // The Stripe rollback is CRITICAL: without it, every duplicate-name
    // attempt orphans a real customer record in Stripe.
    const { service, admin, stripe } = makeService();
    admin.queueCount({ count: 0, error: null });
    admin.setRpcResponse('create_organization_transaction', {
      data: null,
      error: { code: '23505', message: 'duplicate key', details: '', hint: '' },
    });

    const result = await service.createOrganization({
      user: makeUser(),
      organizationName: 'Taken',
      companyName: 'Co',
    });

    expect(result).toEqual({
      success: false,
      error: 'Organization name is already taken',
    });
    expect(stripe.deleteCustomer).toHaveBeenCalledWith('cus_test');
  });

  it('routes "cannot belong to more than" RPC errors to the membership-limit copy', async () => {
    // The DB trigger raises this when the per-user limit is hit
    // transactionally. Different copy than the app-side pre-check.
    const { service, admin } = makeService();
    admin.queueCount({ count: 0, error: null });
    admin.setRpcResponse('create_organization_transaction', {
      data: null,
      error: { message: 'user cannot belong to more than 10 orgs', details: '', hint: '' },
    });

    const result = await service.createOrganization({
      user: makeUser(),
      organizationName: 'X',
      companyName: 'Y',
    });

    expect(result).toEqual({
      success: false,
      error: 'You cannot belong to more than 10 organizations',
    });
  });

});

// ===========================================================================
// acceptInvitation
// ===========================================================================

describe('acceptInvitation', () => {
  function membershipRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'm-1',
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      status: 'pending',
      expires_at: null,
      tenant: {
        tenant_id: TENANT_ID,
        company_name: 'Acme',
        organization_name: 'acme',
      },
      ...overrides,
    };
  }

  // proves AC-077-10
  it('flips status to active and returns tenant info on the happy path', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: membershipRow(), error: null });
    admin.queueCount({ count: 1, error: null });
    admin.queueUpdate({ data: null, error: null });

    const result = await service.acceptInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result).toEqual({ success: true, tenantId: TENANT_ID, companyName: 'Acme' });
  });

  it('returns "Invitation not found" when the membership query errors', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: null, error: { message: 'not found' } });

    const result = await service.acceptInvitation({ user: makeUser(), membershipId: 'bad' });

    expect(result).toEqual({ success: false, error: 'Invitation not found' });
  });

  it('reports a mismatched owner identically to a missing membership, logging the real reason server-side', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: membershipRow({ user_id: 'someone-else' }),
      error: null,
    });

    const result = await service.acceptInvitation({ user: makeUser(), membershipId: 'm-1' });

    // Same client-facing string as a nonexistent membership id — an
    // attacker probing membership ids can't tell "real, someone else's"
    // from "doesn't exist" from the response alone.
    expect(result).toEqual({ success: false, error: 'Invitation not found' });
    expect(serverLoggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining('different user'),
      { membershipId: 'm-1', requestingUserId: USER_ID },
    );
  });

  // proves AC-077-11
  it('returns "already a member" when status is already active', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: membershipRow({ status: 'active' }),
      error: null,
    });

    const result = await service.acceptInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result).toEqual({
      success: false,
      error: 'You are already a member of this organization',
    });
  });

  // proves AC-077-12
  it('returns "expired" when expires_at is in the past', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: membershipRow({ expires_at: '2025-01-01T00:00:00Z' }),
      error: null,
    });

    const result = await service.acceptInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result).toEqual({ success: false, error: 'expired' });
  });

  it('accepts when expires_at is in the FUTURE (boundary check)', async () => {
    // Catches a mutation that flips `<` to `<=` or to `>`.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { service, admin } = makeService();
    admin.queueSingle({
      data: membershipRow({ expires_at: future }),
      error: null,
    });
    admin.queueCount({ count: 1, error: null });
    admin.queueUpdate({ data: null, error: null });

    const result = await service.acceptInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result.success).toBe(true);
  });

  // proves AC-077-13
  it('rejects when user is at the 10-org membership ceiling', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: membershipRow(), error: null });
    admin.queueCount({ count: 10, error: null });

    const result = await service.acceptInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('maximum of 10 organizations');
  });

  it('surfaces the update error when the membership status flip fails', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: membershipRow(), error: null });
    admin.queueCount({ count: 1, error: null });
    admin.queueUpdate({ data: null, error: { message: 'update conflict' } });

    const result = await service.acceptInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result).toEqual({ success: false, error: 'update conflict' });
  });
});

// ===========================================================================
// declineInvitation
// ===========================================================================

describe('declineInvitation', () => {
  function membershipRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'm-1',
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      status: 'pending',
      ...overrides,
    };
  }

  // proves AC-077-15
  it('deletes the pending membership row and reports success on the happy path', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: membershipRow(), error: null });
    admin.queueDelete({ data: [{ id: 'm-1' }], error: null });

    const result = await service.declineInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result).toEqual({ success: true });
    expect(admin.from).toHaveBeenCalledWith('membership');
  });

  it('reports already-accepted when the guarded delete matches no row (a concurrent accept won the race)', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: membershipRow(), error: null });
    // The row read back as pending, but the predicate-guarded delete found
    // nothing — the status flipped between the read and the write.
    admin.queueDelete({ data: [], error: null });

    const result = await service.declineInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result).toEqual({
      success: false,
      error: 'This invitation has already been accepted',
    });
  });

  it('returns "Invitation not found" when the membership query errors', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: null, error: { message: 'not found' } });

    const result = await service.declineInvitation({ user: makeUser(), membershipId: 'bad' });

    expect(result).toEqual({ success: false, error: 'Invitation not found' });
  });

  it('returns "Invitation not found" when the membership row is absent without a query error', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: null, error: null });

    const result = await service.declineInvitation({ user: makeUser(), membershipId: 'bad' });

    expect(result).toEqual({ success: false, error: 'Invitation not found' });
  });

  it('reports a mismatched owner identically to a missing membership, logging the real reason server-side', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: membershipRow({ user_id: 'someone-else' }),
      error: null,
    });

    const result = await service.declineInvitation({ user: makeUser(), membershipId: 'm-1' });

    // Same client-facing string as a nonexistent membership id — an
    // attacker probing membership ids can't tell "real, someone else's"
    // from "doesn't exist" from the response alone.
    expect(result).toEqual({ success: false, error: 'Invitation not found' });
    expect(serverLoggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining('different user'),
      { membershipId: 'm-1', requestingUserId: USER_ID },
    );
  });

  it('refuses to decline an already-active membership — that is removal, not decline', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: membershipRow({ status: 'active' }),
      error: null,
    });

    const result = await service.declineInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result).toEqual({
      success: false,
      error: 'This invitation has already been accepted',
    });
    // No delete should have been issued for an active membership.
    expect(admin.from).toHaveBeenCalledTimes(1);
  });

  it('refuses to decline a disabled membership — reports as no invitation, row untouched', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: membershipRow({ status: 'disabled' }),
      error: null,
    });

    const result = await service.declineInvitation({ user: makeUser(), membershipId: 'm-1' });

    // A disabled membership is not an invitation; letting its owner delete
    // it here would erase the org's suspension record through a
    // self-service path.
    expect(result).toEqual({ success: false, error: 'Invitation not found' });
    expect(admin.from).toHaveBeenCalledTimes(1);
  });

  it('surfaces the delete error when the row removal fails', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: membershipRow(), error: null });
    admin.queueDelete({ data: null, error: { message: 'delete conflict' } });

    const result = await service.declineInvitation({ user: makeUser(), membershipId: 'm-1' });

    expect(result).toEqual({ success: false, error: 'delete conflict' });
  });
});

// ===========================================================================
// getInvitationDetails
// ===========================================================================

describe('getInvitationDetails', () => {
  function detailsRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'm-1',
      user_id: USER_ID,
      status: 'pending',
      expires_at: null,
      tenant: { company_name: 'Acme', organization_name: 'acme' },
      ...overrides,
    };
  }

  it('returns the invitation details for a pending invitation owned by the user', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: detailsRow(), error: null });

    const result = await service.getInvitationDetails({
      user: makeUser(),
      membershipId: 'm-1',
    });

    expect(result).toEqual({
      success: true,
      data: {
        id: 'm-1',
        companyName: 'Acme',
        organizationName: 'acme',
        isExpired: false,
        expiresAt: null,
      },
    });
  });

  it('returns isExpired=true when expires_at is in the past', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: detailsRow({ expires_at: '2025-01-01T00:00:00Z' }),
      error: null,
    });

    const result = await service.getInvitationDetails({
      user: makeUser(),
      membershipId: 'm-1',
    });

    expect(result.data?.isExpired).toBe(true);
  });

  it('returns "Invitation not found" on query error', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({ data: null, error: { message: 'gone' } });

    const result = await service.getInvitationDetails({
      user: makeUser(),
      membershipId: 'm-1',
    });

    expect(result).toEqual({ success: false, error: 'Invitation not found' });
  });

  it('reports a mismatched owner identically to a missing membership, logging the real reason server-side', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: detailsRow({ user_id: 'someone-else' }),
      error: null,
    });

    const result = await service.getInvitationDetails({
      user: makeUser(),
      membershipId: 'm-1',
    });

    expect(result).toEqual({ success: false, error: 'Invitation not found' });
    expect(serverLoggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining('different user'),
      { membershipId: 'm-1', requestingUserId: USER_ID },
    );
  });

  it('returns "already_accepted" when status is active', async () => {
    const { service, admin } = makeService();
    admin.queueSingle({
      data: detailsRow({ status: 'active' }),
      error: null,
    });

    const result = await service.getInvitationDetails({
      user: makeUser(),
      membershipId: 'm-1',
    });

    expect(result).toEqual({ success: false, error: 'already_accepted' });
  });
});

// ===========================================================================
// getMembershipCount
// ===========================================================================

describe('getMembershipCount', () => {
  it('returns the count on success', async () => {
    const { service, server } = makeService();
    server.queueCount({ count: 4, error: null });

    const result = await service.getMembershipCount(makeUser());

    expect(result).toEqual({ success: true, count: 4 });
  });

  it('returns count=0 when supabase reports null', async () => {
    // The `count || 0` fallback — a mutation to `count ?? 0` would
    // preserve `null` and break downstream `result.count.toString()` calls.
    const { service, server } = makeService();
    server.queueCount({ count: null, error: null });

    const result = await service.getMembershipCount(makeUser());

    expect(result).toEqual({ success: true, count: 0 });
  });

  it('returns the error message on failure', async () => {
    const { service, server } = makeService();
    server.queueCount({ count: null, error: { message: 'permission denied' } });

    const result = await service.getMembershipCount(makeUser());

    expect(result).toEqual({ success: false, error: 'permission denied' });
  });

  it('throws when constructed with supabaseServer: null — the only method that reads it', async () => {
    const admin = makeSupabaseMock();
    const service = new OrganizationService({
      supabaseAdmin: admin.client,
      supabaseServer: null,
      stripeService: makeMockStripe(),
    });

    await expect(service.getMembershipCount(makeUser())).rejects.toThrow(
      'getMembershipCount requires a session-bound supabaseServer client',
    );
  });
});
