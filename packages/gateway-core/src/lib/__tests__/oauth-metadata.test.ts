import { describe, expect, it, vi } from 'vitest';
import { requestOrigin } from '../oauth-metadata';

function fakeReq(url: string, headers: Record<string, string> = {}) {
  return { url, header: vi.fn((name: string) => headers[name]) };
}

describe('requestOrigin', () => {
  it('falls back to the request URL\'s own scheme when X-Forwarded-Proto is absent', () => {
    expect(requestOrigin(fakeReq('http://gw.example.com/v1/mcp'))).toBe('http://gw.example.com');
    expect(requestOrigin(fakeReq('https://gw.example.com/v1/mcp'))).toBe('https://gw.example.com');
  });

  it('honors X-Forwarded-Proto: https over an http request URL — the TLS-terminating-proxy case', () => {
    const req = fakeReq('http://gw.example.com/v1/mcp', { 'X-Forwarded-Proto': 'https' });
    expect(requestOrigin(req)).toBe('https://gw.example.com');
  });

  it('honors X-Forwarded-Proto: http over an https request URL too — not a one-way upgrade', () => {
    const req = fakeReq('https://gw.example.com/v1/mcp', { 'X-Forwarded-Proto': 'http' });
    expect(requestOrigin(req)).toBe('http://gw.example.com');
  });

  it('is case-insensitive and trims whitespace on the header value', () => {
    const req = fakeReq('http://gw.example.com/v1/mcp', { 'X-Forwarded-Proto': '  HTTPS  ' });
    expect(requestOrigin(req)).toBe('https://gw.example.com');
  });

  it('falls back to the request URL\'s scheme on a garbage header value', () => {
    const req = fakeReq('https://gw.example.com/v1/mcp', { 'X-Forwarded-Proto': 'javascript:alert(1)' });
    expect(requestOrigin(req)).toBe('https://gw.example.com');
  });

  it('takes the FIRST value of a comma-separated proxy chain, not the last', () => {
    // A multi-hop chain (client -> edge proxy -> internal proxy -> origin)
    // appends the closest hop's protocol last; the client-facing scheme is
    // the first entry.
    const req = fakeReq('http://gw.example.com/v1/mcp', { 'X-Forwarded-Proto': 'https,http' });
    expect(requestOrigin(req)).toBe('https://gw.example.com');
  });

  it('the host always comes from the request URL, never from a header', () => {
    const req = fakeReq('https://internal-host.example.com/v1/mcp', { 'X-Forwarded-Proto': 'https' });
    expect(requestOrigin(req)).toBe('https://internal-host.example.com');
  });
});
