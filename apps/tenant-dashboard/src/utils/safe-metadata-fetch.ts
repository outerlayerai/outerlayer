/**
 * SSRF-safe fetch for SAML metadata URLs (security review M2).
 *
 * `validateMetadataUrl` only blocks HTTP and *literal* private-IP hostnames; a
 * hostname that RESOLVES to an internal IP (or a DNS-rebinding record) sails
 * through. This helper closes that gap for the one server-side fetch we control
 * (SSOConfigService.testConnection):
 *
 *   1. Enforce the static checks (https, not a private IP literal).
 *   2. Resolve the hostname and reject if ANY resolved IP is private/reserved.
 *   3. PIN the TCP connection to a vetted IP via a custom `lookup`, so the
 *      socket connects to exactly the address we checked — a rebinding record
 *      that flips to an internal IP between the check and the connect can't win.
 *   4. Refuse redirects (a 3xx could point at an internal host) and cap the body.
 *
 * TLS/SNI and certificate validation still use the original hostname, so this
 * does not weaken transport security.
 */

import net from 'node:net';
import https from 'node:https';
import dns from 'node:dns/promises';
import { validateMetadataUrl } from './validate-metadata-url';

// Separate v4 and v6 block lists. They MUST stay separate: net.BlockList maps
// IPv4 into IPv4-mapped IPv6 internally, so a `::ffff:0:0/96` rule in a shared
// list would match *every* IPv4 address (including public ones). Routing the
// check by family keeps the v6 rules from leaking into v4 checks.

/** Private, loopback, link-local, CGNAT, and IETF-reserved IPv4 ranges. */
function buildV4BlockList(): InstanceType<typeof net.BlockList> {
  const list = new net.BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4'); // "this host"
  list.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC 1918
  list.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
  list.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
  list.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local (incl. 169.254.169.254 cloud metadata)
  list.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC 1918
  list.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
  list.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
  list.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC 1918
  list.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
  list.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
  list.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
  list.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
  list.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved (incl. 255.255.255.255)
  return list;
}

/** Loopback, unique-local, link-local, mapped/NAT64, and reserved IPv6 ranges. */
function buildV6BlockList(): InstanceType<typeof net.BlockList> {
  const list = new net.BlockList();
  list.addAddress('::', 'ipv6'); // unspecified
  list.addAddress('::1', 'ipv6'); // loopback
  list.addSubnet('::ffff:0:0', 96, 'ipv6'); // IPv4-mapped (blocks reaching v4 space via a mapped literal)
  list.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64
  list.addSubnet('100::', 64, 'ipv6'); // discard-only
  list.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
  list.addSubnet('fc00::', 7, 'ipv6'); // unique local
  list.addSubnet('fe80::', 10, 'ipv6'); // link-local
  list.addSubnet('ff00::', 8, 'ipv6'); // multicast
  return list;
}

const V4_BLOCK_LIST = buildV4BlockList();
const V6_BLOCK_LIST = buildV6BlockList();

/** True if `ip` is a private, loopback, link-local, or otherwise reserved address. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true; // not a valid IP → treat as unsafe
  return family === 4
    ? V4_BLOCK_LIST.check(ip, 'ipv4')
    : V6_BLOCK_LIST.check(ip, 'ipv6');
}

/** Raised when a metadata URL fails SSRF vetting. Message is intentionally generic. */
export class SsrfBlockedError extends Error {
  constructor(message = 'Metadata URL is not allowed') {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const MAX_METADATA_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Injectable DNS + HTTPS seam. Defaults to node's built-ins; tests pass fakes
 * directly (dependency injection) rather than `vi.mock`-ing node builtins,
 * which is deterministic and avoids a module-graph load race under vitest's
 * threads pool.
 */
export interface MetadataFetchDeps {
  resolve: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request: typeof https.request;
}

const DEFAULT_DEPS: MetadataFetchDeps = {
  resolve: (hostname) => dns.lookup(hostname, { all: true }),
  request: https.request,
};

/**
 * Fetch a SAML metadata URL with SSRF protection. Returns the HTTP status and
 * body on success; throws SsrfBlockedError when the URL resolves to a
 * disallowed address (or redirects). Only ever connects to a vetted public IP.
 */
export async function fetchSsoMetadataSafely(
  rawUrl: string,
  opts: { timeoutMs?: number } = {},
  deps: MetadataFetchDeps = DEFAULT_DEPS,
): Promise<{ status: number; body: string }> {
  const { timeoutMs = 10_000 } = opts;

  // (1) static checks: https + not a private IP literal.
  validateMetadataUrl(rawUrl);
  const url = new URL(rawUrl);

  // (2) resolve every IP and reject if ANY is private/reserved.
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await deps.resolve(url.hostname);
  } catch {
    throw new SsrfBlockedError('Metadata URL host could not be resolved');
  }
  if (resolved.length === 0) {
    throw new SsrfBlockedError('Metadata URL host could not be resolved');
  }
  for (const { address } of resolved) {
    if (isPrivateOrReservedIp(address)) {
      throw new SsrfBlockedError('Metadata URL resolves to a private or reserved address');
    }
  }
  // (3) pin the connection to a vetted IP so no re-resolution can flip it.
  const pinned = resolved[0]!;

  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = deps.request(
      rawUrl,
      {
        method: 'GET',
        timeout: timeoutMs,
        // Custom lookup returns ONLY the pre-vetted IP; TLS/SNI/cert still use
        // url.hostname (defeats DNS rebinding without weakening transport auth).
        lookup: (_hostname, _options, cb) => cb(null, pinned.address, pinned.family),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // (4) never follow redirects — a 3xx could point at an internal host.
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new SsrfBlockedError('Metadata URL responded with a redirect'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_METADATA_BYTES) {
            req.destroy();
            reject(new SsrfBlockedError('Metadata response exceeded the size limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Metadata fetch timed out')));
    req.on('error', reject);
    req.end();
  });
}
