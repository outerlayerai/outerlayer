/**
 * Validates that a SAML metadata URL is safe to fetch server-side.
 *
 * Enforces:
 * - Must be a well-formed URL
 * - Must use HTTPS (not HTTP or other schemes)
 * - Hostname must not be localhost or a private/internal IP address
 *
 * Note: DNS resolution is not performed; IP-range checks apply to literal
 * IP hostnames only. Domain names that resolve to private IPs are out of
 * scope for this static check.
 *
 * @throws {Error} with a descriptive message if the URL fails validation
 */
export function validateMetadataUrl(rawUrl: string): void {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid metadata URL: must be a well-formed URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Invalid metadata URL: must use HTTPS');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname === '::1') {
    throw new Error('Invalid metadata URL: internal hostnames are not allowed');
  }

  if (isPrivateIpv4(hostname)) {
    throw new Error('Invalid metadata URL: private IP addresses are not allowed');
  }
}

/**
 * Returns true if the hostname is a literal IPv4 address in a private range.
 * Covered ranges: 127.x (loopback), 10.x (RFC 1918), 172.16-31.x (RFC 1918),
 * 192.168.x (RFC 1918), 169.254.x (link-local / cloud metadata).
 */
function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');

  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map(Number);

  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }

  const a = octets[0]!;
  const b = octets[1]!;

  return (
    // 169.254.0.0/16 link-local
    // 192.168.0.0/16 RFC 1918
    (a === 127 ||                              // 127.0.0.0/8  loopback
    a === 10 ||                               // 10.0.0.0/8   RFC 1918
    (a === 172 && b >= 16 && b <= 31) ||      // 172.16.0.0/12 RFC 1918
    (a === 192 && b === 168) || (a === 169 && b === 254))
  );
}
