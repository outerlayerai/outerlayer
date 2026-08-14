import { classifyCommand, commandPairKey, detectTestResult, extractCommandText, isTestFilePath, splitCommandSegments } from "./classify";
import type { CommandRun, Facts, FactFamily, FileEdit, TimelineSpan } from "./types";

/**
 * The single extraction pass: tool-call spans (already ordered — sessions by
 * start, spans by timestamp within each) → `Facts`. Everything validators
 * know about a PR's work passes through here, so this is where capture-tier
 * reality is confronted honestly:
 *
 *  - `coverage` reports which fact families the input actually carried.
 *    Below-full tiers store no command content, so a timeline full of tool
 *    spans with empty Input yields NO `commands` coverage — and validators
 *    that need commands answer `not_checkable` instead of fabricating a
 *    pass or a fail from silence.
 *  - `seq` is assigned over the merged order and is the only ordering facts
 *    expose. Span timestamps are synthetic within a session (a sequence, not
 *    wall clock), so cross-session interleaving finer than "session A ended,
 *    session B began" is not represented — and no validator may pretend
 *    otherwise.
 */
export function extractFacts(spans: readonly TimelineSpan[]): Facts {
  const runs: CommandRun[] = [];
  const edits: FileEdit[] = [];
  const coverage = new Set<FactFamily>();

  // Coverage means CAPABILITY, not occurrence: a session that made no edits
  // is still checkable for edit-dependent rules (the answer is "none"), so
  // `edits` is covered whenever tool spans exist at all — edit flags are
  // structural metadata every adapter emits. `commands` stays occurrence-
  // based below: command CONTENT is tier-gated, and its absence really does
  // mean "cannot check", not "nothing ran".
  if (spans.length > 0) coverage.add("edits");

  spans.forEach((span, seq) => {
    if (span.isEdit && span.file) {
      edits.push({
        seq,
        sessionIndex: span.sessionIndex,
        turnIndex: span.turnIndex,
        status: span.status,
        file: span.file,
        isTestFile: isTestFilePath(span.file),
      });
      return;
    }
    const commandText = span.command === undefined ? null : extractCommandText(span.command);
    if (commandText === null) return;
    coverage.add("commands");
    // Segment-aware: every statement in a compound classifies independently,
    // so a test run (or a bypassed git command) buried mid-chain is seen.
    // Segments that classify `other` collapse to one run for the whole span.
    const segments = splitCommandSegments(commandText);
    const classifiedSegments = segments
      .map((segment) => classifyCommand(segment))
      .filter((c) => c.kind !== "other");
    const toEmit = classifiedSegments.length > 0 ? classifiedSegments : [classifyCommand(commandText)];
    for (const classified of toEmit) {
      const testResult =
        classified.kind === "test"
          ? detectTestResult(classified.normalized, span.status, span.output)
          : undefined;
      runs.push({
        seq,
        sessionIndex: span.sessionIndex,
        turnIndex: span.turnIndex,
        status: span.status,
        kind: classified.kind,
        normalized: classified.normalized,
        pairKey: commandPairKey(classified.normalized),
        suiteScope: classified.suiteScope,
        bypass: classified.bypass,
        ...(testResult !== undefined ? { testResult } : {}),
        ...(span.errorSignature ? { errorSignature: span.errorSignature } : {}),
      });
    }
  });

  return { runs, edits, coverage };
}
