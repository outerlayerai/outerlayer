// @vitest-environment node
//
// NextRequest pulls in Next.js internals that touch `new TextEncoder()` at
// module-load time; the jsdom polyfill isn't installed early enough. Node's
// built-in TextEncoder matches production, so run this file under node.

/**
 * The webhook on a deployment with no GitHub App configured.
 *
 * GITHUB_APP_WEBHOOK_SECRET is optional config — a deployment without a GitHub
 * App still serves sessions and traces. Without the secret there is no way to
 * verify a signature, and the one thing the route must never do is fall through
 * to processing an unverified payload. It answers 503 instead of 401, because
 * "not configured" and "bad signature" send an operator hunting in different
 * places.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

beforeAll(() => {
  if (typeof (globalThis.Response as unknown as { json?: unknown }).json !== 'function') {
    (globalThis.Response as unknown as { json: unknown }).json = (
      body: unknown,
      init?: ResponseInit,
    ) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
  }
});

const { mockHandleInstallation, mockHandlePullRequest } = vi.hoisted(() => ({
  mockHandleInstallation: vi.fn(),
  mockHandlePullRequest: vi.fn(),
}));

vi.mock('@/config-global.server', () => ({
  GITHUB_APP_ID: '123456',
  GITHUB_APP_WEBHOOK_SECRET: undefined,
}));

// Pinned so the assertions below prove the route never reached a handler,
// rather than proving the handlers happened to be inert.
vi.mock('../handle-installtion-event', () => ({
  handleInstallationEvent: mockHandleInstallation,
}));
vi.mock('../handle-pull-request-event', () => ({
  handlePullRequestEvent: mockHandlePullRequest,
}));

import { POST } from '../route';

function webhookRequest(body: unknown, signature?: string): NextRequest {
  return new NextRequest('https://dash.test/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/webhooks/github without a configured GitHub App', () => {
  it('refuses with 503 and processes nothing, even for a signed-looking payload', async () => {
    const res = await POST(
      webhookRequest({ action: 'created' }, 'sha256=deadbeef'),
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toBe('GitHub App is not configured on this deployment');
    expect(mockHandleInstallation).not.toHaveBeenCalled();
    expect(mockHandlePullRequest).not.toHaveBeenCalled();
  });

  it('refuses the same way when no signature header is present', async () => {
    const res = await POST(webhookRequest({ action: 'created' }));

    expect(res.status).toBe(503);
    expect(mockHandleInstallation).not.toHaveBeenCalled();
  });
});
