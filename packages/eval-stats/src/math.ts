// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Deterministic numerical primitives: the inverse normal CDF, z quantiles,
 * Wilson score intervals, the exact McNemar p-value, binomial coefficients,
 * percentiles, and output rounding. All pure; no external dependencies.
 */

/**
 * Inverse standard-normal CDF (quantile) via Acklam's rational approximation.
 * Relative error < 1.15e-9 across (0, 1) — nine significant figures, ample for
 * z-quantiles (z_{0.975} = 1.959963985...). Pure and deterministic: only
 * `Math.log`/`Math.sqrt` (IEEE-754 correctly-rounded), so the output is
 * bit-stable across platforms. Exactly antisymmetric about p = 0.5 (the central
 * branch is odd in p − 0.5), so `invNormCdf(0.5) === 0`.
 */
export function invNormCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/** z quantile for a two-sided test at level `alpha` (e.g. 0.05 -> 1.9599...). */
export function zForAlpha(alpha: number): number {
  return invNormCdf(1 - alpha / 2);
}

/** z quantile for target `power` (e.g. 0.8 -> 0.8416...). */
export function zForPower(power: number): number {
  return invNormCdf(power);
}

/**
 * Wilson score interval for a binomial proportion. Robust near 0 and 1 where
 * the normal (Wald) interval fails. `n === 0` returns the no-information
 * interval [0, 1] with value 0.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  alpha = 0.05,
): { value: number; ci95: [number, number] } {
  if (n <= 0) return { value: 0, ci95: [0, 1] };
  const z = zForAlpha(alpha);
  const z2 = z * z;
  const phat = successes / n;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const half =
    (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  const lo = Math.max(0, center - half);
  const hi = Math.min(1, center + half);
  return { value: phat, ci95: [lo, hi] };
}

/**
 * Two-sided exact McNemar p-value from discordant counts `b` and `c`.
 *
 * Under H0 each discordant pair is an independent fair coin, so the count on
 * one side is Binomial(b + c, 1/2). We sum the two-sided tail exactly via an
 * overflow-safe iterative PMF (never forms C(n, i) directly). `b + c === 0`
 * (no discordance) yields p = 1.
 */
export function mcnemarExactP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let pmf = Math.pow(0.5, n); // i = 0 term
  let cum = pmf;
  for (let i = 1; i <= k; i += 1) {
    pmf = (pmf * (n - i + 1)) / i; // C(n,i) 0.5^n from the previous term
    cum += pmf;
  }
  return Math.min(1, 2 * cum);
}

/** Binomial coefficient C(n, k) as a float. 0 outside 0 <= k <= n. */
export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < kk; i += 1) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * The `p`-quantile of a SORTED array by the type-7 (linear interpolation)
 * method — R's default and the convention we pin in goldens. Propagates
 * `Infinity` at the tails (used by the cost-ratio bootstrap).
 */
export function percentileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  const a = sorted[lo];
  const bnd = sorted[hi];
  // Guard Inf*0 = NaN when an endpoint is Infinity and its weight is 0/1.
  if (frac === 0) return a;
  if (frac === 1) return bnd;
  return a * (1 - frac) + bnd * frac;
}

/**
 * Cost-ratio in cross-multiplied form so 0/0 is well defined. Returns
 * `(xNum / xDen)` where the caller passes the cross-products; `den === 0` with
 * `num > 0` is `Infinity`, and `0/0` is `1` (both configs equally, infinitely
 * unproductive — no evidence of a difference).
 */
export function safeRatio(num: number, den: number): number {
  if (den === 0) return num === 0 ? 1 : Infinity;
  return num / den;
}

/** Round a display number to 10 decimals; pass `Infinity`/`NaN` through; kill `-0`. */
export function round10(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 1e10) / 1e10 + 0;
}

/** `round10` a fixed-length CI tuple. */
export function round10Pair(pair: [number, number]): [number, number] {
  return [round10(pair[0]), round10(pair[1])];
}
