/**
 * The verification fact layer's contracts. Everything downstream — built-in
 * validators now, user-authored declarative validators later — consumes
 * `Facts`; nothing below this file reads raw spans or sessions. Validators
 * are pure and deterministic: same `Facts` + `VerdictCtx` in, same
 * `RuleResult` out, every run. That property is load-bearing (verdicts must
 * be recomputable by anyone), so no validator may read clocks, randomness,
 * or the network.
 */

/** One tool-call span, projected to the fields the fact layer reads. Rows
 * MUST be in within-session time order; cross-session order is the caller's
 * responsibility (sessions sorted by their start, spans by Timestamp). */
export interface TimelineSpan {
  sessionIndex: number;
  turnIndex: number | null;
  toolName: string;
  status: "ok" | "error" | "rejected";
  isEdit: boolean;
  file?: string;
  errorSignature?: string;
  /** Raw command content when the tool ran a command (full tier only). */
  command?: string;
  /** Raw command output (full tier only) — the failure-detection source for
   * piped test runs, whose exit codes report the LAST pipeline stage. */
  output?: string;
}

export type CommandKind = "test" | "lint" | "build" | "vcs" | "migration" | "other";

/** Whether a test run plausibly covered the whole suite. `partial` (a path
 * or filter argument) exists so no row can ever claim suite-wide green off a
 * single-file run — the row-copy rule depends on this distinction. */
export type SuiteScope = "full" | "partial" | "unknown";

export interface CommandRun {
  /** Position in the merged timeline — the only ordering facts may use. */
  seq: number;
  sessionIndex: number;
  turnIndex: number | null;
  status: "ok" | "error" | "rejected";
  kind: CommandKind;
  normalized: string;
  /** Pipeline-stripped identity: `vitest run x | tail -5` and `| tail -25`
   * are the SAME command for pairing purposes. Display keeps `normalized`. */
  pairKey: string;
  suiteScope: SuiteScope;
  /** Reliable outcome for test runs only. Derived from run OUTPUT when
   * present, falling back to exit status ONLY for unpiped commands — a piped
   * command's exit code is the last stage's, so a failing `vitest … | tail`
   * exits 0. Undefined = could not be reliably determined (or not a test). */
  testResult?: "pass" | "fail";
  /** True when the command carries a hook/check bypass flag. */
  bypass: boolean;
  errorSignature?: string;
}

export interface FileEdit {
  seq: number;
  sessionIndex: number;
  turnIndex: number | null;
  status: "ok" | "error" | "rejected";
  file: string;
  isTestFile: boolean;
}

/** Fact families adapters may or may not capture. A validator whose `needs`
 * aren't covered must return `not_checkable` — never a silent pass and never
 * a false fail. */
export type FactFamily = "commands" | "edits";

export interface Facts {
  runs: CommandRun[];
  edits: FileEdit[];
  coverage: ReadonlySet<FactFamily>;
}

export interface VerdictCtx {
  /** Whether the PR's diff adds test files. The backtest approximates this
   * from session edits when the diff isn't available; the live path must use
   * the real diff. */
  diffAddsTests: boolean;
}

type RuleStatus = "pass" | "flag" | "absent" | "not_checkable";

export interface RuleResult {
  id: string;
  status: RuleStatus;
  /** Red-class flags are the only results allowed to produce the "can't
   * verify" verdict; everything else caps at amber. */
  redClass?: true;
  /** Plain-language row text. May state only what the matcher proved. */
  summary: string;
  /** Timeline positions backing the result — the proof links. */
  refs: Array<{ sessionIndex: number; turnIndex: number | null }>;
}

export interface Validator {
  id: string;
  needs: readonly FactFamily[];
  /** Silent validators compute (their result feeds composition and other
   * rules' witnesses) but never render a row. */
  silent?: true;
  evaluate(facts: Facts, ctx: VerdictCtx): RuleResult;
}
