import type {
  CustomValidationFact,
  PolicyErrorFact,
  VerificationFact,
} from "@/lib/system/pr-session-comment/evaluate";
import { noTestTampering, redThenGreen, testsAfterLastEdit } from "./validators";
import type { CustomRuleResult } from "./custom";
import type { PolicyProblem } from "./policy";
import type { Facts, RuleResult, VerdictCtx } from "./types";

/**
 * Verification results for the evidence comment: extracted facts → built-in
 * rule results → the displayed-fact shape `evaluateEvidence` appends.
 *
 * Only pass/flag results become facts. `absent` (nothing proven, nothing
 * wrong — e.g. tests never seen failing) and `not_checkable` (capture
 * lacked command content) are omitted: a row may only claim what a matcher
 * proved, and these have nothing to claim in either direction.
 */

/** The validators whose results render as rows. The silent one evaluates in
 * {@link builtinRuleResults} for composition but never appears here. */
const DISPLAYED_VALIDATORS = [redThenGreen, noTestTampering] as const;

/**
 * Every built-in fact-layer result by id — the displayed pair plus the
 * silent tests-after-last-edit, which computes so custom validators can
 * reference it (`require.validator`) even though it renders no row itself.
 */
export function builtinRuleResults(facts: Facts, ctx: VerdictCtx): ReadonlyMap<string, RuleResult> {
  return new Map(
    [redThenGreen, noTestTampering, testsAfterLastEdit].map((validator) => [
      validator.id,
      validator.evaluate(facts, ctx),
    ]),
  );
}

/**
 * The displayed verification facts from already-evaluated built-in results.
 * `results` comes from {@link builtinRuleResults}; the caller owns building
 * `VerdictCtx` (`diffAddsTests: null` — an unreadable file list — must
 * arrive as `false`, conservatively suppressing red-then-green, a rule that
 * must never fire on approximation).
 */
export function verificationFacts(
  results: ReadonlyMap<string, RuleResult>,
  traceIds: readonly string[],
): VerificationFact[] {
  const out: VerificationFact[] = [];
  for (const validator of DISPLAYED_VALIDATORS) {
    const result = results.get(validator.id);
    if (!result || (result.status !== "pass" && result.status !== "flag")) continue;
    out.push({
      id: result.id as VerificationFact["id"],
      status: result.status,
      class: result.redClass ? "red" : "amber",
      sentence: result.summary,
      refs: toTraceRefs(result.refs, traceIds),
    });
  }
  return out;
}

/** Session-index refs → trace-id refs, dropping any index outside the trace
 * list — a fact may only point at sessions the comment actually shows. */
function toTraceRefs(
  refs: ReadonlyArray<{ sessionIndex: number; turnIndex: number | null }>,
  traceIds: readonly string[],
): Array<{ traceId: string; turnIndex: number | null }> {
  return refs
    .filter((ref) => ref.sessionIndex >= 0 && ref.sessionIndex < traceIds.length)
    .map((ref) => ({ traceId: traceIds[ref.sessionIndex]!, turnIndex: ref.turnIndex }));
}

/**
 * Custom validators' results → displayed facts. `class` is `"amber"` by
 * construction — the type admits nothing else, which is what "user checks
 * are capped at amber" means structurally. `off` never arrives (an off
 * validator produced no result) and `absent` never arrives (an unmatched
 * `when:` scope produced no result), so every result here is a row.
 */
export function customValidationFacts(
  results: readonly CustomRuleResult[],
  traceIds: readonly string[],
): CustomValidationFact[] {
  return results.map((result) => ({
    type: "custom-validation",
    id: result.id,
    status: result.status,
    class: "amber",
    level: result.level,
    sentence: result.row,
    refs: toTraceRefs(result.refs, traceIds),
    source: result.source,
  }));
}

/** The single loud row for broken config: the first problem named, the rest
 * counted. Null when the policy loaded clean. */
export function policyErrorFact(problems: readonly PolicyProblem[]): PolicyErrorFact | null {
  const first = problems[0];
  if (!first) return null;
  return {
    type: "policy-error",
    status: "flag",
    class: "amber",
    file: first.file,
    problem: first.problem,
    additionalProblemCount: problems.length - 1,
  };
}
