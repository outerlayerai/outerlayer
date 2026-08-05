import { EventEmitter } from 'node:events';
import {
  isPrivateOrReservedIp,
  fetchSsoMetadataSafely,
  SsrfBlockedError,
  type MetadataFetchDeps,
} from '../safe-metadata-fetch';

// ── isPrivateOrReservedIp ────────────────────────────────────────────────────
// Pure function over real node:net (no mocking).

describe('isPrivateOrReservedIp', () => {
  it.each([
    // Public — must be allowed
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['203.0.114.1', false], // just outside TEST-NET-3 (203.0.113.0/24)
    ['2606:4700:4700::1111', false], // public IPv6 (Cloudflare)
    // Private / loopback / link-local / reserved — must be blocked
    ['127.0.0.1', true], // loopback
    ['10.0.0.1', true], // RFC 1918
    ['172.16.5.4', true], // RFC 1918
    ['172.31.255.255', true], // RFC 1918 upper edge
    ['192.168.1.1', true], // RFC 1918
    ['169.254.169.254', true], // cloud metadata (link-local)
    ['100.64.0.1', true], // CGNAT
    ['0.0.0.0', true], // "this host"
    ['255.255.255.255', true], // reserved
    ['224.0.0.1', true], // multicast
    ['::1', true], // IPv6 loopback
    ['fc00::1', true], // IPv6 unique-local
    ['fe80::1', true], // IPv6 link-local
    ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
    ['not-an-ip', true], // invalid → unsafe
  ])('classifies %s as private=%s', (ip, expected) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected);
  });
});

// ── fetchSsoMetadataSafely ───────────────────────────────────────────────────
// The DNS + HTTPS seam is dependency-injected (deps arg), so tests pass fakes
// directly instead of vi.mock-ing node builtins.

describe('fetchSsoMetadataSafely', () => {
  let mockResolve: ReturnType<typeof vi.fn>;
  let mockRequest: ReturnType<typeof vi.fn>;
  let deps: MetadataFetchDeps;

  beforeEach(() => {
    mockResolve = vi.fn();
    mockRequest = vi.fn();
    deps = {
      resolve: mockResolve as unknown as MetadataFetchDeps['resolve'],
      request: mockRequest as unknown as MetadataFetchDeps['request'],
    };
  });

  /** Fake https.ClientRequest whose response emits the given status/body. */
  function stubHttpsResponse(status: number, body = '') {
    mockRequest.mockImplementation(
      (_url: string, _opts: unknown, cb: (res: EventEmitter & { statusCode: number; resume: () => void }) => void) => {
        const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
        req.end = () => {
          const res = Object.assign(new EventEmitter(), { statusCode: status, resume: () => {} });
          cb(res);
          queueMicrotask(() => {
            if (body) res.emit('data', Buffer.from(body));
            res.emit('end');
          });
        };
        req.destroy = () => {};
        return req;
      },
    );
  }

  it('rejects a non-HTTPS URL before any DNS resolution', async () => {
    await expect(fetchSsoMetadataSafely('http://idp.example.com/meta', {}, deps)).rejects.toThrow(/HTTPS/);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('rejects when the host resolves to a private IP — and never opens a connection', async () => {
    mockResolve.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(
      fetchSsoMetadataSafely('https://metadata.attacker.com/x', {}, deps),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects when ANY resolved IP is private (mixed public + internal)', async () => {
    mockResolve.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);

    await expect(
      fetchSsoMetadataSafely('https://rebind.example.com/x', {}, deps),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects when the host cannot be resolved', async () => {
    mockResolve.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      fetchSsoMetadataSafely('https://nope.example.com/x', {}, deps),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('pins the connection to the vetted public IP and returns the body on 200', async () => {
    mockResolve.mockResolvedValue([{ address: '203.0.114.9', family: 4 }]);
    stubHttpsResponse(200, '<EntityDescriptor/>');

    const result = await fetchSsoMetadataSafely('https://idp.example.com/metadata', {}, deps);

    expect(result).toEqual({ status: 200, body: '<EntityDescriptor/>' });
    // The request was pinned: the custom lookup returns ONLY the vetted IP.
    const opts = mockRequest.mock.calls[0]![1] as {
      lookup: (h: string, o: unknown, cb: (e: null, a: string, f: number) => void) => void;
    };
    const pinned = vi.fn();
    opts.lookup('idp.example.com', {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, '203.0.114.9', 4);
  });

  it('refuses to follow redirects (a 3xx could point at an internal host)', async () => {
    mockResolve.mockResolvedValue([{ address: '203.0.114.9', family: 4 }]);
    stubHttpsResponse(302);

    await expect(
      fetchSsoMetadataSafely('https://idp.example.com/metadata', {}, deps),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
