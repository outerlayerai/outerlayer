// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Problem-statement generation with leak scrubbing (step 3).
 *
 * The statement is a bug report written from the observable symptom and the
 * failing-test output. It MUST NOT name the injected diff's location or
 * content: a statement that says "the off-by-one in paginate()" turns a
 * bug-fix task into a fill-in-the-blank. We scrub the injected function name,
 * file path, and basename VERBATIM, and expose a `LeakSpotCheck` seam so a
 * judge can spot-check that the bug isn't locatable from the statement alone.
 *
 * This also keeps the gate's own `statement_leak` lint quiet: that lint flags a task
 * `needs_review` when the statement names a symbol the gold_patch defines — and
 * our gold_patch is the revert of the injected function.
 */

/** Identifiers that must never appear verbatim in a problem statement. */
export interface LeakTargets {
  functionName: string;
  filePath: string;
}

export interface StatementInputs {
  /** Observable behavior (no diff location/content). */
  symptom: string;
  /** Raw failing-test output — may contain the target names; scrubbed. */
  failingTestOutput?: string;
  /** The failing test ids, quoted in the report; scrubbed for leaked names. */
  failingTests?: string[];
}

/**
 * Spot-check seam: given a statement and the true injection target, estimate
 * the probability a judge can LOCATE the bug from the statement alone. Real
 * impl is a BYO-key judge; tests inject a scripted one. Lower is better.
 */
export interface LeakSpotCheck {
  locate(statement: string, targets: LeakTargets): Promise<number>;
}

const MIN_STATEMENT_LENGTH = 40; // matches evalTaskSchema's problem_statement floor
const REDACTION = "[redacted]";
const PADDING = "Investigate the regression and restore the previous behavior.";

/** The distinctive tokens to scrub, longest-first so subtokens can't partial-match. */
function leakTokens(targets: LeakTargets): string[] {
  const tokens = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.trim().length > 0) tokens.add(value);
  };
  add(targets.functionName);
  add(targets.filePath);
  if (targets.filePath) {
    const base = targets.filePath.split("/").pop();
    if (base) {
      add(base);
      const noExt = base.replace(/\.[^.]+$/, "");
      if (noExt.length >= 4) add(noExt); // avoid scrubbing short/common tokens
    }
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}

/** Replace every leaked identifier with a neutral redaction marker. */
export function scrubLeaks(text: string, targets: LeakTargets): string {
  let out = text;
  for (const token of leakTokens(targets)) {
    out = out.split(token).join(REDACTION);
  }
  return out;
}

/** The leaked identifiers still present verbatim in a statement ([] = clean). */
export function statementLeaks(statement: string, targets: LeakTargets): string[] {
  return leakTokens(targets).filter((token) => statement.includes(token));
}

/** Throw if a statement still names any injected identifier verbatim. */
export function assertNoLeak(statement: string, targets: LeakTargets): void {
  const leaks = statementLeaks(statement, targets);
  if (leaks.length > 0) {
    throw new Error(`problem statement leaks injected identifiers: ${leaks.join(", ")}`);
  }
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 200);
  }
  return "";
}

/**
 * Assemble the bug report from the symptom and failing-test evidence, then
 * scrub every leaked identifier. The fixed framing keeps the result above the
 * schema's 40-char floor even after aggressive scrubbing.
 */
export function generateProblemStatement(inputs: StatementInputs, targets: LeakTargets): string {
  const parts: string[] = ["A recent change introduced a regression."];
  if (inputs.symptom.trim().length > 0) parts.push(inputs.symptom.trim());
  if (inputs.failingTests && inputs.failingTests.length > 0) {
    parts.push(`The following existing tests now fail: ${inputs.failingTests.join(", ")}.`);
  }
  const excerpt = inputs.failingTestOutput ? firstMeaningfulLine(inputs.failingTestOutput) : "";
  if (excerpt.length > 0) parts.push(`Observed failure: ${excerpt}`);
  parts.push("Restore the previously correct behavior so the suite passes again.");

  const scrubbed = scrubLeaks(parts.join(" "), targets).replace(/\s+/g, " ").trim();
  return scrubbed.length >= MIN_STATEMENT_LENGTH ? scrubbed : `${scrubbed} ${PADDING}`.trim();
}
