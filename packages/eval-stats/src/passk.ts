// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Unbiased pass@k and pass^k estimators over a task's trials.
 *
 * Both are single-task estimators over `n` trials with `c` successes; a report
 * averages them across tasks. They are exact combinatorial expectations of
 * drawing `k` of the `n` trials WITHOUT replacement — the Codex/HumanEval
 * unbiased form, not the biased "did any of the first k pass" plug-in.
 */

import { comb } from "./math.js";

/**
 * pass@k: probability that at least one of `k` trials drawn without
 * replacement from `n` (of which `c` succeeded) is a success.
 *
 *   pass@k = 1 − C(n − c, k) / C(n, k)
 *
 * Requires 1 <= k <= n. When every failing draw is impossible (n − c < k) this
 * is 1; when there are no successes it is 0.
 */
export function passAtKUnbiased(c: number, n: number, k: number): number {
  if (k < 1 || k > n) throw new RangeError(`passAtK: need 1 <= k(${k}) <= n(${n})`);
  if (n - c < k) return 1;
  return 1 - comb(n - c, k) / comb(n, k);
}

/**
 * pass^k ("pass-hat-k"): probability that ALL `k` trials drawn without
 * replacement from `n` (of which `c` succeeded) are successes — a consistency
 * / reliability metric.
 *
 *   pass^k = C(c, k) / C(n, k)
 *
 * Requires 1 <= k <= n. It is 0 when c < k.
 */
export function passHatKUnbiased(c: number, n: number, k: number): number {
  if (k < 1 || k > n) throw new RangeError(`passHatK: need 1 <= k(${k}) <= n(${n})`);
  if (c < k) return 0;
  return comb(c, k) / comb(n, k);
}
