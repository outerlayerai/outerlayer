// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

export {
  CARD_SCHEMA_VERSION,
  buildReportCard,
  verdictLabel,
  type CardInputs,
  type CardStats,
  type DivergentTask,
  type FailureTaxonomy,
  type PerTaskRow,
  type Ratio,
  type ReportCard,
  type Verdict,
} from "./card.js";
export { assertCardIntegrity, CardIntegrityError, namesWinner } from "./integrity.js";
export { renderCardHtml, renderCardText } from "./render.js";
