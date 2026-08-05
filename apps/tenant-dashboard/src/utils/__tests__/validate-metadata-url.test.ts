import { describe, expect, it } from 'vitest';

import { validateMetadataUrl } from '../validate-metadata-url';

const PRIVATE_IP_ERROR = 'Invalid metadata URL: private IP addresses are not allowed';

describe('validateMetadataUrl private-IPv4 (SSRF) checks', () => {
  // Every entry pins one branch/boundary in isPrivateIpv4 so that mutating any
  // comparison (=== / >= / <= / || / &&) or a conditional flips a result here.
  const blocked: Array<[string, string]> = [
    ['127.0.0.1', '127.x loopback (a === 127)'],
    ['10.0.0.1', '10.x RFC1918 (a === 10)'],
    ['172.16.0.1', '172.16 lower bound (b >= 16)'],
    ['172.31.255.255', '172.31 upper bound (b <= 31)'],
    ['192.168.0.1', '192.168 (a === 192 && b === 168)'],
    ['169.254.0.1', '169.254 link-local (a === 169 && b === 254)'],
  ];

  const allowed: Array<[string, string]> = [
    ['172.15.0.1', 'b = 15, just below the 172.16 lower bound'],
    ['172.32.0.1', 'b = 32, just above the 172.31 upper bound'],
    ['192.167.0.1', 'b = 167, just below 192.168'],
    ['192.169.0.1', 'b = 169, just above 192.168'],
    ['169.253.0.1', 'b = 253, just below 169.254'],
    ['8.8.8.8', 'public DNS'],
    ['1.1.1.1', 'public DNS'],
  ];

  it.each(blocked)('blocks private/internal IP %s (%s)', (ip) => {
    expect(() => validateMetadataUrl(`https://${ip}/metadata`)).toThrowError(
      PRIVATE_IP_ERROR,
    );
  });

  it.each(allowed)('allows public IP %s (%s)', (ip) => {
    // Void on success; asserting undefined both runs the check (a throw fails
    // the test) and pins the "returns nothing" contract.
    expect(validateMetadataUrl(`https://${ip}/metadata`)).toBeUndefined();
  });
});
