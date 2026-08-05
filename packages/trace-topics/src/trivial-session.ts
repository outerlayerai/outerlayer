/**
 * Deterministic gate for transcripts with NO developer-typed content.
 *
 * A session whose user turns are wholly harness traffic — slash-command
 * envelopes (/clear), local-command caveats, relayed peer/agent messages,
 * system notifications — contains nothing to summarize, yet a model asked to
 * summarize it describes the harness mechanics anyway ("the user attempted
 * to clear the session…"). Those descriptions embed, cluster densely (the
 * shape is templated), and surface as top task "topics". Detecting the shape
 * is mechanical, so it is decided HERE, before any model call: the enrichment
 * writer turns a trivial trace into NONE marker rows for the batched facets —
 * terminal, never embedded, zero model spend.
 *
 * The gate is deliberately narrow: it fires only when the trace HAS agent
 * user-turn spans and NONE of them carry developer-typed text after harness
 * stripping. A short-but-real turn ("fix it"), a greeting test, or any plain
 * OTLP trace without session structure goes to the model as before — prompt
 * wording owns the judgment calls; this gate owns only the no-content case.
 */

import { stripHarnessNoise } from './steering-facet';
import type { TracePreprocessorSpan } from './trace-preprocessor';

const USER_TURN_SPAN = 'agent.turn.user';

function turnText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** True when the trace is session-shaped and no user turn survives stripping. */
export function isHarnessOnlySession(
  spans: readonly TracePreprocessorSpan[],
): boolean {
  const userTurns = spans.filter((s) => s.name === USER_TURN_SPAN);
  if (userTurns.length === 0) return false;
  return userTurns.every(
    (turn) => stripHarnessNoise(turnText(turn.input)).length === 0,
  );
}
