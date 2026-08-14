import { describe, expect, it } from 'vitest';
import { maskActorId, maskActorIds } from '../services/actor-id-mask';

const SECRET = 'test-oauth-state-secret-at-least-32-chars';
const OTHER_SECRET = 'a-different-secret-that-is-also-32-chars';

describe('maskActorId', () => {
  it('never returns the raw actorId, or a value containing it as a substring', async () => {
    const pseudonym = await maskActorId(SECRET, 'membership-a1b2c3');
    expect(pseudonym).not.toBe('membership-a1b2c3');
    expect(pseudonym.includes('membership-a1b2c3')).toBe(false);
    expect(pseudonym).toMatch(/^anon-[0-9a-f]{16}$/);
  });

  it('is deterministic: the same actorId and secret always produce the same pseudonym', async () => {
    const first = await maskActorId(SECRET, 'membership-a1b2c3');
    const second = await maskActorId(SECRET, 'membership-a1b2c3');
    expect(first).toBe(second);
  });

  it('produces different pseudonyms for different actorIds', async () => {
    const a = await maskActorId(SECRET, 'membership-a');
    const b = await maskActorId(SECRET, 'membership-b');
    expect(a).not.toBe(b);
  });

  it('produces different pseudonyms for the same actorId under different secrets', async () => {
    const a = await maskActorId(SECRET, 'membership-a');
    const b = await maskActorId(OTHER_SECRET, 'membership-a');
    expect(a).not.toBe(b);
  });
});

describe('maskActorIds', () => {
  it('maps every id to its pseudonym, matching maskActorId one at a time', async () => {
    const ids = ['membership-a', 'membership-b'];
    const map = await maskActorIds(SECRET, ids);
    expect(Object.keys(map).sort()).toEqual(ids.slice().sort());
    for (const id of ids) {
      expect(map[id]).toBe(await maskActorId(SECRET, id));
    }
  });

  it('returns an empty map for an empty input', async () => {
    expect(await maskActorIds(SECRET, [])).toEqual({});
  });
});
