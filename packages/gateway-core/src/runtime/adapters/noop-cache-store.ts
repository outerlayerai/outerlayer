/**
 * Self-host impl of the L2 `CacheL2Store` — an explicit no-op (NOT `null`).
 *
 * Every read is a miss and every write is discarded, so the tiered cache falls
 * back to the always-present L1 `MemoryStore`. This is the "disabled L2" adapter
 * the self-host composition root injects when there is no `CLOUDFLARE_*` store —
 * per the no-default-adapters rule, disabled is an injected adapter, not `null`.
 *
 * Vendor-free, so it lives in core alongside the interfaces it implements; the
 * Node composition root (`apps/gateway-node`, Step 5) constructs it.
 */
import { Ok } from "@unkey/error";
import type { CacheL2Store } from "../gateway-context";

export class NoopCacheStore implements CacheL2Store {
  public readonly name = "noop";

  async get(): ReturnType<CacheL2Store["get"]> {
    return Ok(undefined); // always a cache miss → L1 serves
  }

  async set(): ReturnType<CacheL2Store["set"]> {
    return Ok(); // discard
  }

  async remove(): ReturnType<CacheL2Store["remove"]> {
    return Ok();
  }
}
