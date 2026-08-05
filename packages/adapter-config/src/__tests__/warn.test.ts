import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetWarnLatch, warnLegacyOnce } from '../warn';

afterEach(() => {
  resetWarnLatch();
  vi.restoreAllMocks();
});

describe('warnLegacyOnce', () => {
  it('warns the first time for a key and returns true', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnLegacyOnce('seam-a', 'use the new name')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('use the new name');
  });

  it('is a no-op on subsequent calls for the same key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnLegacyOnce('seam-a', 'first');
    expect(warnLegacyOnce('seam-a', 'second')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('first');
  });

  it('latches independently per key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnLegacyOnce('seam-a', 'a')).toBe(true);
    expect(warnLegacyOnce('seam-b', 'b')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('resetWarnLatch(key) re-arms only that key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnLegacyOnce('seam-a', 'a1');
    warnLegacyOnce('seam-b', 'b1');
    resetWarnLatch('seam-a');
    expect(warnLegacyOnce('seam-a', 'a2')).toBe(true);
    expect(warnLegacyOnce('seam-b', 'b2')).toBe(false);
    // a1 + b1 + a2 warned; b2 was suppressed (seam-b never re-armed).
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenLastCalledWith('a2');
  });

  it('resetWarnLatch() re-arms every key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnLegacyOnce('seam-a', 'a1');
    warnLegacyOnce('seam-b', 'b1');
    resetWarnLatch();
    expect(warnLegacyOnce('seam-a', 'a2')).toBe(true);
    expect(warnLegacyOnce('seam-b', 'b2')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
