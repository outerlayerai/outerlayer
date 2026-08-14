import type { VerificationFact } from "@/lib/system/pr-session-comment/evaluate";
import { extractFacts } from "./facts";
import { noTestTampering, redThenGreen } from "./validators";
import type { RuleResult, TimelineSpan } from "./types";

/**
 * Verification results for the evidence comment: session tool-call spans →
 * fact layer → the displayed-fact shape `evaluateEvidence` appends.
 *
 * Only pass/flag results become facts. `absent` (nothing proven, nothing
 * wrong — e.g. tests never seen failing) and `not_checkable` (capture
 * lacked command content) are omitted: a row may only claim what a matcher
 * proved, and these have nothing to claim in either direction.
 *
 * `diffAddsTests` is the PR's REAL file list saying test files were added
 * or changed; `null` means the list could not be read, which conservatively
 * suppresses red-then-green (a rule that must never fire on approximation)
 * while tampering — which needs no diff — still evaluates.
 */
export function verificationFacts(
  spans: readonly TimelineSpan[],
  traceIds: readonly string[],
  diffAddsTests: boolean | null,
): VerificationFact[] {
  const facts = extractFacts(spans);
  const ctx = { diffAddsTests: diffAddsTests === true };
  const results = [redThenGreen.evaluate(facts, ctx), noTestTampering.evaluate(facts, ctx)];
  const out: VerificationFact[] = [];
  for (const result of results) {
    if (result.status !== "pass" && result.status !== "flag") continue;
    out.push({
      id: result.id as VerificationFact["id"],
      status: result.status,
      class: result.redClass ? "red" : "amber",
      sentence: result.summary,
      refs: toTraceRefs(result, traceIds),
    });
  }
  return out;
}

function toTraceRefs(
  result: RuleResult,
  traceIds: readonly string[],
): VerificationFact["refs"] {
  return result.refs
    .filter((ref) => ref.sessionIndex >= 0 && ref.sessionIndex < traceIds.length)
    .map((ref) => ({ traceId: traceIds[ref.sessionIndex]!, turnIndex: ref.turnIndex }));
}
