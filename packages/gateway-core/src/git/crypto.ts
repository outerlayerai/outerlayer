/**
 * Git-token encryption for the Cloudflare-Workers gateway.
 *
 * The AES-256-GCM scheme itself lives in `@repo/git-providers`. This file is
 * only the Workers-side seam: it pulls `TOKEN_ENCRYPTION_KEY` off the Worker
 * `Env` and forwards to the shared implementation.
 */

import { encryptToken as encrypt, decryptToken as decrypt } from "@repo/git-providers";
import type { Env } from "../types";

export function encryptToken(plaintext: string, env: Env): Promise<string> {
  return encrypt(plaintext, env.TOKEN_ENCRYPTION_KEY);
}

export function decryptToken(encrypted: string, env: Env): Promise<string> {
  return decrypt(encrypted, env.TOKEN_ENCRYPTION_KEY);
}
