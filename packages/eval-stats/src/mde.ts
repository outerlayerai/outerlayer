// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Minimum Detectable Effect (MDE) for the paired resolve-rate delta, via the
 * standard closed-form McNemar power approximation.
 *
 * Derivation. The paired test operates on discordant pairs. Under H0 the
 * per-task signed outcome d_i ∈ {−1, 0, +1} has P(d = 0) = 1 − p_d and
 * P(d = ±1) = p_d / 2, so Var(d) = p_d, giving SE(estimate) = sqrt(p_d / n).
 * The smallest true delta detectable at power (1 − β), two-sided level α, is
 *
 *   MDE = (z_{α/2} + z_β) · sqrt(p_d / n)
 *
 * where p_d is the discordance rate. This is monotonically DECREASING in n and
 * INCREASING in p_d, and it reproduces the spec's power figures (10pp needs
 * ~157–235 pairs at p_d ∈ [0.2, 0.3]; 15pp needs ~70–105).
 *
 * The formula is parameterized purely by (n, p_d): the repo report calls it pre-run with an
 * ASSUMED discordance in [0.2, 0.3]; the report calls it with the OBSERVED
 * discordance. Additional trials per task enter only through their effect on
 * the observed discordance — more trials denoise the per-task majority label,
 * lowering discordance when disagreement is noise-driven, which lowers the
 * MDE. See README "MDE and the role of k".
 */

import { zForAlpha, zForPower } from "./math.js";
import type { MdeParams } from "./types.js";

/**
 * The minimum detectable effect (a proportion) at the given power. Returns
 * `Infinity` when `nPairs <= 0` (nothing is detectable with no data) and `0`
 * when `discordanceRate === 0` (perfect concordance detects any effect).
 */
export function mde(params: MdeParams): number {
  const { nPairs, discordanceRate, power = 0.8, alpha = 0.05 } = params;
  if (nPairs <= 0) return Infinity;
  if (discordanceRate <= 0) return 0;
  const zSum = zForAlpha(alpha) + zForPower(power);
  return zSum * Math.sqrt(discordanceRate / nPairs);
}

/**
 * Inverse of {@link mde}: the number of paired tasks needed to bring the MDE
 * down to `targetDelta` at the given discordance and power. Rounded up. This
 * is the "prescription" attached to an `underpowered` verdict.
 *
 *   n = p_d · ((z_{α/2} + z_β) / δ)^2
 */
export function tasksNeeded(
  targetDelta: number,
  params: Omit<MdeParams, "nPairs">,
): number {
  const { discordanceRate, power = 0.8, alpha = 0.05 } = params;
  const delta = Math.abs(targetDelta);
  if (delta <= 0) return Infinity;
  if (discordanceRate <= 0) return 0;
  const zSum = zForAlpha(alpha) + zForPower(power);
  return Math.ceil(discordanceRate * (zSum / delta) ** 2);
}

/**
 * The human-readable MDE note for a card or the docs. `assumption` describes
 * the source of the discordance figure (observed vs assumed).
 */
export function mdeNote(
  params: MdeParams & { assumption: string },
): string {
  const value = mde(params);
  const pp = (value * 100).toFixed(1);
  const disc = params.discordanceRate.toFixed(2);
  const powerPct = ((params.power ?? 0.8) * 100).toFixed(0);
  return (
    `Detectable Δ ≈ ${pp} pp at ${powerPct}% power ` +
    `(n=${params.nPairs} paired tasks, discordance=${disc}; ${params.assumption}).`
  );
}
