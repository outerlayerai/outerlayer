// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * A seeded, deterministic pseudo-random number generator.
 *
 * The whole package's determinism rests on this: no `Math.random`, no
 * `Date.now`. Same seed => same stream => byte-identical statistics. We use
 * mulberry32 — a tiny, well-distributed 32-bit generator with a full period
 * over its state, more than enough for bootstrap resampling and world
 * simulation.
 */

/** A function that returns the next uniform float in [0, 1). */
export type Rng = () => number;

/**
 * Construct a mulberry32 generator from an integer seed. The seed is coerced
 * to a uint32, so `mulberry32(1)` and `mulberry32(1 + 2**32)` share a stream.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform integer in [0, n). Deterministic given the rng. */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/**
 * Draw `n` indices in [0, n) with replacement — one bootstrap resample of a
 * dataset of size `n`. Returns a fresh array each call.
 */
export function resampleIndices(rng: Rng, n: number): Int32Array {
  const out = new Int32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (rng() * n) | 0;
  return out;
}
