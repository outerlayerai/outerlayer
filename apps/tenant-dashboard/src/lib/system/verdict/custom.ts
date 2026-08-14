import type { CustomValidationFact } from "@/lib/system/pr-session-comment/evaluate";
import { toTraceRefs } from "./evidence";
import { extractFacts } from "./facts";
import { normalizeCommand } from "./classify";
import { noTestTampering, redThenGreen } from "./validators";
import type { CustomValidator, RequireCondition } from "./policy";
import type { Facts, RuleResult, TimelineSpan } from "./types";

/**
 * Evaluates a policy's custom validators against the same fact layer the
 * built-ins read. Pure and deterministic — a custom is a condition over
 * computed facts, so identical inputs always produce identical facts.
 *
 * Display doctrine, inherited not reimplemented:
 *  - a custom whose `when.paths` did not match the PR produces no row;
 *  - a custom whose needed fact families were not captured produces no row
 *    (not checkable — never a silent pass, never a false fail), exactly as
 *    the built-ins omit their not-checkable results;
 *  - an `emitted:` condition evaluates as UNKNOWN while the delivery
 *    channel is unwired, and an unknown can suppress a row but never flag
 *    one — a result that had no way to arrive is not a failure;
 *  - a flag renders the row's own copy plus "not proven", claiming only
 *    that the required proof was not found.
 */

type ConditionOutcome =
  | { state: "met"; refs: Array<{ sessionIndex: number; turnIndex: number | null }> }
  | { state: "unmet" }
  | { state: "unknown" };

export function customValidationFacts(
  customs: readonly CustomValidator[],
  spans: readonly TimelineSpan[],
  traceIds: readonly string[],
  prFilePaths: readonly string[] | null,
  diffAddsTests: boolean | null,
): CustomValidationFact[] {
  const validations = customs.filter((custom) => custom.kind === "validation");
  if (validations.length === 0) return [];

  const facts = extractFacts(spans);
  const ctx = { diffAddsTests: diffAddsTests === true };
  // Built-in results computed once for `require.validator` references.
  const builtinResults = new Map<string, RuleResult>([
    ["red-then-green", redThenGreen.evaluate(facts, ctx)],
    ["no-test-tampering", noTestTampering.evaluate(facts, ctx)],
  ]);

  const out: CustomValidationFact[] = [];
  for (const custom of validations) {
    if (custom.whenPaths !== null) {
      // An unreadable file list means the scope cannot be proven either way,
      // so a path-scoped validator stays quiet rather than guessing.
      if (prFilePaths === null) continue;
      const globs = custom.whenPaths.map(globToRegExp);
      if (!prFilePaths.some((path) => globs.some((glob) => glob.test(path)))) continue;
    }
    if (!custom.needs.every((family) => facts.coverage.has(family))) continue;

    const outcomes = custom.require.conditions.map((condition) =>
      evaluateCondition(condition, facts, builtinResults),
    );
    const met = outcomes.filter(
      (outcome): outcome is Extract<ConditionOutcome, { state: "met" }> => outcome.state === "met",
    );
    const hasUnknown = outcomes.some((outcome) => outcome.state === "unknown");
    const hasUnmet = outcomes.some((outcome) => outcome.state === "unmet");

    let status: "pass" | "flag" | null;
    let refs: Array<{ sessionIndex: number; turnIndex: number | null }>;
    if (custom.require.mode === "any") {
      if (met.length > 0) {
        status = "pass";
        refs = met[0]!.refs;
      } else if (hasUnknown) {
        status = null;
        refs = [];
      } else {
        status = "flag";
        refs = [];
      }
    } else {
      if (hasUnmet) {
        status = "flag";
        refs = [];
      } else if (hasUnknown) {
        status = null;
        refs = [];
      } else {
        status = "pass";
        refs = met.flatMap((outcome) => outcome.refs);
      }
    }
    if (status === null) continue;

    out.push({
      id: "custom",
      validatorId: custom.id,
      status,
      class: "amber",
      sentence: status === "pass" ? custom.row : `${custom.row} — not proven`,
      refs: toTraceRefs({ refs }, traceIds),
    });
  }
  return out;
}

/** Flags that make an invocation a no-op: `cmd --help` exits 0 without
 * doing anything, so a word-prefix match on them would let the cheapest
 * possible command satisfy a proof. Only the unambiguous long forms are
 * listed — `-h` commonly means a host, not help, and a false suppression
 * here would flag work that genuinely happened. (Function-scoped so the
 * mutation gate can attribute coverage; module-level constants read as
 * unkillable static mutants.) */
function argsNegateRun(argsTail: string): boolean {
  const noRunFlags = ["--help", "--dry-run", "--version"];
  return argsTail
    .trim()
    .split(/\s+/)
    .some((token) => noRunFlags.includes(token));
}

function evaluateCondition(
  condition: RequireCondition,
  facts: Facts,
  builtinResults: ReadonlyMap<string, RuleResult>,
): ConditionOutcome {
  switch (condition.kind) {
    case "session-ran": {
      const wanted = normalizeCommand(condition.command);
      const run = facts.runs.find(
        (candidate) =>
          candidate.status === "ok" &&
          candidate.testResult !== "fail" &&
          (candidate.normalized === wanted ||
            (candidate.normalized.startsWith(`${wanted} `) &&
              !argsNegateRun(candidate.normalized.slice(wanted.length)))),
      );
      if (!run) return { state: "unmet" };
      return { state: "met", refs: [{ sessionIndex: run.sessionIndex, turnIndex: run.turnIndex }] };
    }
    case "validator": {
      const result = builtinResults.get(condition.id);
      if (!result || result.status === "not_checkable") return { state: "unknown" };
      // A required validator that is merely absent is an ask without its
      // proof — unmet, exactly like a command that never ran.
      if (result.status === "pass") return { state: "met", refs: result.refs };
      return { state: "unmet" };
    }
    case "emitted":
      return { state: "unknown" };
    default: {
      const exhaustive: never = condition;
      void exhaustive;
      return { state: "unknown" };
    }
  }
}

const REGEXP_SPECIALS = /[.+?^${}()|[\]\\]/g;

function escapeSegment(segment: string): string {
  return segment
    .split("*")
    .map((part) => part.replace(REGEXP_SPECIALS, "\\$&"))
    .join("[^/]*");
}

/** `*` matches within a path segment, `**` matches across segments. The
 * subset the design's examples use — anything fancier belongs to a real
 * glob engine, adopted deliberately. */
export function globToRegExp(glob: string): RegExp {
  const segments = glob.split("/");
  const pieces = segments.map((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === "**") return isLast ? ".*" : "(?:[^/]+/)*";
    return isLast ? escapeSegment(segment) : `${escapeSegment(segment)}/`;
  });
  return new RegExp(`^${pieces.join("")}$`);
}
