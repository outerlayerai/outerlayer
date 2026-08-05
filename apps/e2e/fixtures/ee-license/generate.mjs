/**
 * (Re)generates the committed TEST enterprise-license fixture used by the
 * chromium-selfhost-licensed Playwright project.
 *
 *   node fixtures/ee-license/generate.mjs
 *
 * TEST KEYPAIR ONLY. The keypair minted here is throwaway: the public key is
 * injected into the licensed self-host dashboard via OUTERLAYER_EE_PUBLIC_KEY
 * for the duration of the e2e run. It has no relationship to the production
 * license public key (which is baked into @repo/ee-license / provided by
 * real deployments), so committing this fixture grants nothing.
 *
 * Token format must match packages/ee-license/src/license.ts:
 *   outerlayer_ee_v1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PREFIX = 'outerlayer_ee_v1';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const claims = {
  org: 'E2E Selfhost Licensed Org',
  plan: 'enterprise',
  iat: Math.floor(Date.parse('2026-07-10T00:00:00Z') / 1000),
  // Far-future expiry so the committed fixture never rots mid-run. If this
  // date is ever near, rerun this script.
  exp: Math.floor(Date.parse('2036-01-01T00:00:00Z') / 1000),
};

const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
const message = `${PREFIX}.${payloadB64}`;
const signature = sign(null, Buffer.from(message, 'ascii'), privateKey);

const fixture = {
  note: 'TEST license fixture for e2e only — regenerate with generate.mjs. Unrelated to any production key.',
  publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  licenseKey: `${message}.${signature.toString('base64url')}`,
  claims,
};

const out = join(dirname(fileURLToPath(import.meta.url)), 'test-license.json');
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out}`);
