/**
 * Route-level tests for GET /.well-known/oauth-protected-resource
 * (RFC 9728 protected-resource metadata) and its per-app-mount sibling.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AppContext } from '../_shared';
import { GetOAuthProtectedResourceMetadata, GetAppScopedOAuthProtectedResourceMetadata } from '../oauth';

const MOCK_ROUTE_OPTIONS = {
  router: { getRequest: () => ({}) },
  raiseUnknownParameters: false,
  route: '/test',
  urlParams: [],
};

function buildContext(url: string, supabaseApiBaseUrl: string, headers: Record<string, string> = {}): AppContext {
  return {
    req: {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource',
      url,
      header: vi.fn((name: string) => headers[name]),
    },
    env: { SUPABASE_API_BASE_URL: supabaseApiBaseUrl },
    json: vi.fn((body: unknown, status?: number) => ({ body, status })),
  } as unknown as AppContext;
}

function appScopedRoute(params: { appId: string }): GetAppScopedOAuthProtectedResourceMetadata {
  const route = new GetAppScopedOAuthProtectedResourceMetadata(MOCK_ROUTE_OPTIONS);
  route.validatedData = { params };
  return route;
}

describe('GetOAuthProtectedResourceMetadata', () => {
  it('advertises this gateway\'s /v1/mcp endpoint as the resource, at 200', async () => {
    const route = new GetOAuthProtectedResourceMetadata(MOCK_ROUTE_OPTIONS);
    const c = buildContext('https://gw.example.com/.well-known/oauth-protected-resource', 'https://proj.supabase.co');

    const result = (await route.handle(c)) as unknown as { body: unknown; status: number };

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      resource: 'https://gw.example.com/v1/mcp',
      authorization_servers: ['https://proj.supabase.co'],
    });
  });

  it('derives the resource origin from the REQUEST url, not a hardcoded host', async () => {
    const route = new GetOAuthProtectedResourceMetadata(MOCK_ROUTE_OPTIONS);
    const c = buildContext('https://other-host.example.org/.well-known/oauth-protected-resource', 'https://proj.supabase.co');

    const result = (await route.handle(c)) as unknown as { body: { resource: string } };

    expect(result.body.resource).toBe('https://other-host.example.org/v1/mcp');
  });

  it('points authorization_servers at the configured Supabase project, not a fixed value', async () => {
    const route = new GetOAuthProtectedResourceMetadata(MOCK_ROUTE_OPTIONS);
    const c = buildContext('https://gw.example.com/x', 'https://another-project.supabase.co');

    const result = (await route.handle(c)) as unknown as { body: { authorization_servers: string[] } };

    expect(result.body.authorization_servers).toEqual(['https://another-project.supabase.co']);
  });

  it('honors X-Forwarded-Proto: https behind a TLS-terminating proxy that hands this process a plain-http request URL', async () => {
    const route = new GetOAuthProtectedResourceMetadata(MOCK_ROUTE_OPTIONS);
    const c = buildContext('http://gw.example.com/.well-known/oauth-protected-resource', 'https://proj.supabase.co', {
      'X-Forwarded-Proto': 'https',
    });

    const result = (await route.handle(c)) as unknown as { body: { resource: string } };

    expect(result.body.resource).toBe('https://gw.example.com/v1/mcp');
  });
});

describe('GetAppScopedOAuthProtectedResourceMetadata', () => {
  it('advertises the per-app MCP mount as the resource, echoing the path appId, at 200', async () => {
    const route = appScopedRoute({ appId: 'app-123' });
    const c = buildContext(
      'https://gw.example.com/.well-known/oauth-protected-resource/v1/apps/app-123/mcp',
      'https://proj.supabase.co',
    );

    const result = (await route.handle(c)) as unknown as { body: unknown; status: number };

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      resource: 'https://gw.example.com/v1/apps/app-123/mcp',
      authorization_servers: ['https://proj.supabase.co'],
    });
  });

  it('a different appId path segment produces a different resource, not a fixed one', async () => {
    const route = appScopedRoute({ appId: 'app-456' });
    const c = buildContext(
      'https://gw.example.com/.well-known/oauth-protected-resource/v1/apps/app-456/mcp',
      'https://proj.supabase.co',
    );

    const result = (await route.handle(c)) as unknown as { body: { resource: string } };

    expect(result.body.resource).toBe('https://gw.example.com/v1/apps/app-456/mcp');
  });

  it('derives the resource origin from the REQUEST url, not a hardcoded host', async () => {
    const route = appScopedRoute({ appId: 'app-123' });
    const c = buildContext(
      'https://other-host.example.org/.well-known/oauth-protected-resource/v1/apps/app-123/mcp',
      'https://proj.supabase.co',
    );

    const result = (await route.handle(c)) as unknown as { body: { resource: string } };

    expect(result.body.resource).toBe('https://other-host.example.org/v1/apps/app-123/mcp');
  });

  it('points authorization_servers at the configured Supabase project, same as the bare mount', async () => {
    const route = appScopedRoute({ appId: 'app-123' });
    const c = buildContext(
      'https://gw.example.com/x',
      'https://another-project.supabase.co',
    );

    const result = (await route.handle(c)) as unknown as { body: { authorization_servers: string[] } };

    expect(result.body.authorization_servers).toEqual(['https://another-project.supabase.co']);
  });

  it('honors X-Forwarded-Proto: https behind a TLS-terminating proxy that hands this process a plain-http request URL', async () => {
    const route = appScopedRoute({ appId: 'app-123' });
    const c = buildContext(
      'http://gw.example.com/.well-known/oauth-protected-resource/v1/apps/app-123/mcp',
      'https://proj.supabase.co',
      { 'X-Forwarded-Proto': 'https' },
    );

    const result = (await route.handle(c)) as unknown as { body: { resource: string } };

    expect(result.body.resource).toBe('https://gw.example.com/v1/apps/app-123/mcp');
  });
});
