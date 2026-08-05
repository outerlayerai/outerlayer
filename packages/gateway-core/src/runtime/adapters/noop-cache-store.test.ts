import { describe, it, expect } from 'vitest';
import { NoopCacheStore } from './noop-cache-store';

/**
 * The self-host "disabled L2" adapter. Its whole contract is: every read is a
 * miss (so the tiered cache falls through to L1) and every write is silently
 * discarded — all returning `@unkey/cache`'s `Ok` result shape, never throwing.
 */
describe('NoopCacheStore', () => {
  const store = new NoopCacheStore();

  it('identifies as the "noop" store', () => {
    expect(store.name).toBe('noop');
  });

  it('get() resolves Ok with an undefined value — always a cache miss', async () => {
    const result = await store.get('any-namespace', 'any-key');
    expect(result.err).toBeUndefined();
    expect(result.val).toBeUndefined();
  });

  it('set() resolves Ok — the write is discarded, not persisted', async () => {
    const result = await store.set('ns', 'key', { any: 'value' });
    expect(result.err).toBeUndefined();
    // A subsequent read still misses — nothing was stored.
    const readBack = await store.get('ns', 'key');
    expect(readBack.val).toBeUndefined();
  });

  it('remove() resolves Ok', async () => {
    const single = await store.remove('ns', 'key');
    expect(single.err).toBeUndefined();
    const many = await store.remove('ns', ['key-a', 'key-b']);
    expect(many.err).toBeUndefined();
  });
});
