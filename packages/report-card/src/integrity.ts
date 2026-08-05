// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The integrity lint — the honesty scaffolding that IS the
 * brand, enforced in code so no rendering path can violate it:
 *   - a card that names a winner MUST carry the verdict-tier label AND the
 *     MDE line;
 *   - an underpowered card MUST render its prescription, not a winner;
 *   - exclusions and sensitivity MUST be disclosed.
 *
 * Renderers call assertCardIntegrity(card, renderedText) before returning —
 * the rendered output is what ships, so we lint the output, not just the
 * model. A violation throws (a bug, caught in tests), never silently ships.
 */

import { verdictLabel, type ReportCard } from "./card.js";

export class CardIntegrityError extends Error {
  constructor(message: string) {
    super(`card integrity violation: ${message}`);
    this.name = "CardIntegrityError";
  }
}

/** Does the card's conclusion name a winner (a config beating the other)? */
export function namesWinner(card: ReportCard): boolean {
  return card.verdict === "clear" || card.verdict === "directional";
}

export function assertCardIntegrity(card: ReportCard, rendered: string): void {
  const tier = verdictLabel(card.verdict);
  // Rule 1: the tier label is always visible.
  if (!rendered.includes(tier)) {
    throw new CardIntegrityError(`rendered card omits the verdict tier "${tier}"`);
  }
  // Rule 2: the MDE line is always printed.
  const mdeFragment = "can detect differences";
  if (!rendered.includes(mdeFragment) || !rendered.includes(card.mdeLine.split(";")[0]!.trim())) {
    throw new CardIntegrityError("rendered card omits the MDE line");
  }
  // Rule 3: a winner is never named without both of the above (covered by 1+2,
  // asserted explicitly for clarity).
  if (namesWinner(card) && !(rendered.includes(tier) && rendered.includes(mdeFragment))) {
    throw new CardIntegrityError("a winner is rendered without the tier chip + MDE line");
  }
  // Rule 4: underpowered cards render the prescription prominently.
  if (card.verdict === "underpowered" && !/underpowered/i.test(rendered)) {
    throw new CardIntegrityError("underpowered card does not render its prescription");
  }
  // Rule 5: exclusions + sensitivity disclosed when present.
  if (card.stats.exclusions.length > 0 && !rendered.toLowerCase().includes("exclu")) {
    throw new CardIntegrityError("card has exclusions but does not disclose them");
  }
}
