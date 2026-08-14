import type { LinkedSessionRow } from "./read";

/**
 * The evidence evaluation behind the PR session comment's verdict: displayed
 * facts in, a verdict out.
 *
 * PURE, like `render.ts` — no I/O, no clock, no randomness. Determinism is a
 * product guarantee, not a style choice: re-evaluating unchanged inputs must
 * produce an identical result (and therefore an identical comment body), and
 * every stored evaluation must be recomputable by anyone from the same
 * inputs.
 *
 * Facts vs verdicts: a fact states something checkable about the PR's work
 * ("k of n commits came from recorded sessions"); the verdict is derived
 * from the facts and nothing else. Fact CLASS is what bounds the damage a
 * fact can do — an amber fact can flag the verdict but can never produce the
 * red "can't verify" verdict on its own. Commit provenance is amber by
 * design: humans push fixups onto agent PRs constantly, and "human commit"
 * vs "uncaptured agent commit" is not reliably distinguishable, so an
 * unrecorded commit asks for a look, never declares the PR unverifiable.
 */

/**
 * Minimum shared SHA prefix for a commit to count as recorded. Seven hex
 * characters is git's own default abbreviation floor; anything shorter is
 * too collision-prone to accept as identity, so a recorded sha below this
 * length matches nothing rather than everything it happens to prefix.
 */
const MIN_SHA_PREFIX_LENGTH = 7;

type EvidenceVerdict = "pass" | "flag" | "unverifiable" | "waiting";

/**
 * A discriminated union from day one so the next validator lands as a new
 * member, not a refactor — which is exactly how the verification facts
 * landed: computed by the span fact layer (`lib/system/verdict`), passed in
 * already evaluated, appended to the same list the verdict derives from.
 */
export type EvidenceFact =
  | CommitProvenanceFact
  | VerificationFact
  | CustomValidationFact
  | PolicyErrorFact
  | IssueAskFact
  | IssueAskErrorFact;

/**
 * A verification validator's displayed result, produced by
 * `verdict/evidence.ts` from session tool-call timelines. Only pass/flag
 * results become facts: an `absent` result (nothing proven, nothing wrong)
 * and a `not_checkable` one (capture lacked command content) are omitted
 * rather than rendered as claims either way.
 */
export interface VerificationFact {
  id: "red-then-green" | "no-test-tampering";
  status: "pass" | "flag";
  /** `red` only for the check-bypass flag — the one verification failure
   * that makes the PR unverifiable rather than merely worth a look. */
  class: "amber" | "red";
  /** The design's row copy, verbatim from the validator. */
  sentence: string;
  /** Timeline positions backing the result — turn numbers within the trace
   * they belong to, for "· turn N" suffixes and future deep links. */
  refs: Array<{ traceId: string; turnIndex: number | null }>;
}

/**
 * A user-authored validator's displayed result, produced by
 * `verdict/custom.ts` from the repo's own policy files. Amber by
 * construction: no custom can make a PR unverifiable — the red class stays
 * reserved for the engine's tamper checks.
 */
export interface CustomValidationFact {
  id: "custom";
  /** The custom's own id from its policy file — the display-level key. */
  validatorId: string;
  status: "pass" | "flag";
  class: "amber";
  /** The custom's `row:` copy verbatim; a flag carries "— not proven". */
  sentence: string;
  refs: Array<{ traceId: string; turnIndex: number | null }>;
}

/**
 * A policy that exists but is broken — fail loudly at load, not silently at
 * check time. One row for the whole policy: the first problem by file
 * order, with the remainder counted. Never leveled: a policy cannot turn
 * off the row that reports the policy is broken.
 */
export interface PolicyErrorFact {
  id: "policy-error";
  status: "flag";
  class: "amber";
  /** Pre-composed "file — problem" text; the renderer shows it verbatim. */
  message: string;
}

/**
 * A linked issue's "Validation required" entry, evaluated. Amber by
 * construction — an unmet ask asks for a look; it can never make the PR
 * unverifiable — and never leveled: issues tighten, they cannot be muted.
 */
export interface IssueAskFact {
  id: "issue-ask";
  status: "pass" | "flag";
  class: "amber";
  /** Pre-composed claim: what was asked and whether its proof exists. */
  sentence: string;
  issueNumber: number;
  refs: Array<{ traceId: string; turnIndex: number | null }>;
}

/** A malformed or dangling ask — same fail-loudly contract as a broken
 * policy file: one row, first problem named, remainder counted. */
export interface IssueAskErrorFact {
  id: "issue-ask-error";
  status: "flag";
  class: "amber";
  message: string;
}

interface CommitProvenanceFact {
  id: "commits-from-sessions";
  /** `flag` when any PR commit matched no recorded session commit. */
  status: "pass" | "flag";
  /** Amber can flag the verdict; only a red-class fact may ever produce
   * "unverifiable" (reachable since the verification facts landed — a
   * check-bypass is red; provenance stays amber by design). */
  class: "amber" | "red";
  /** k — PR commits matched to a recorded session commit. */
  matchedCommitCount: number;
  /** n — commits on the PR. */
  totalCommitCount: number;
  /** Full lowercase SHAs of the PR commits no session recorded, in the PR's
   * own commit order. Empty when the fact passes. */
  unrecordedShas: string[];
}

export interface EvidenceEvaluation {
  verdict: EvidenceVerdict;
  facts: EvidenceFact[];
  /** Facts whose status is `flag` — the N in "Look at N things". */
  flaggedCount: number;
  /** Sessions claiming this PR whose links are still pending confirmation.
   * Carried on the evaluation so the waiting state can be rendered and the
   * stored record says what was known at evaluation time. */
  pendingLinkCount: number;
}

interface EvaluateEvidenceInput {
  /** The confirmed sessions the comment renders. Only the recorded commit
   * shas participate in evaluation. */
  sessions: ReadonlyArray<Pick<LinkedSessionRow, "recordedCommitShas">>;
  pendingLinkCount: number;
  /** The PR's own commit SHAs, in PR order. `null` means "could not be
   * read" (no client method, a 403/404) — distinct from an empty PR: an
   * unreadable commit list omits the fact rather than asserting a pass or a
   * flag it cannot know. */
  prCommitShas: readonly string[] | null;
  /** Verification results computed from session timelines by the span fact
   * layer. Already pure and deterministic; evaluation appends them to the
   * displayed facts unchanged. Empty when spans could not be read — same
   * omission contract as an unreadable commit list. */
  verificationFacts?: readonly VerificationFact[];
  /** User-authored validator results from the repo's policy (`verdict/custom.ts`). */
  customFacts?: readonly CustomValidationFact[];
  /** The policy's load failure, if any — appended after every other fact. */
  policyError?: PolicyErrorFact | null;
  /** Evaluated "Validation required" entries from the PR's linked issues. */
  issueAskFacts?: readonly IssueAskFact[];
  /** The asks' parse failure, if any — appended with the policy error. */
  issueAskError?: IssueAskErrorFact | null;
  /** Display levels from the repo's policy, keyed by validator id
   * (`validatorId` for customs). `off` drops the fact before display;
   * `info` keeps the row but excludes its flag from the verdict; absent
   * ids default to full participation. The policy-error fact is exempt —
   * a policy cannot silence the row that reports it is broken. */
  factLevels?: ReadonlyMap<string, "warn" | "info" | "off">;
}

/** The level key: built-ins by fact id, customs by their policy id. Error
 * rows and issue asks are exempt — a policy cannot silence the row that
 * reports it is broken, and issues tighten without being levelable. */
function levelKeyOf(fact: EvidenceFact): string | null {
  if (fact.id === "policy-error" || fact.id === "issue-ask" || fact.id === "issue-ask-error") {
    return null;
  }
  return fact.id === "custom" ? fact.validatorId : fact.id;
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

/**
 * A PR commit counts as recorded when it shares a ≥7-character prefix with
 * any recorded session commit — either may be the truncated spelling
 * (sessions record what the transcript captured, which can be an
 * abbreviated sha), so the prefix test runs in both directions.
 */
function isRecorded(prSha: string, recordedShas: readonly string[]): boolean {
  if (prSha.length < MIN_SHA_PREFIX_LENGTH) return false;
  return recordedShas.some(
    (recorded) =>
      recorded.length >= MIN_SHA_PREFIX_LENGTH &&
      (prSha.startsWith(recorded) || recorded.startsWith(prSha)),
  );
}

function commitProvenanceFact(
  sessions: EvaluateEvidenceInput["sessions"],
  prCommitShas: readonly string[],
): CommitProvenanceFact {
  // The union of every confirmed session's recorded commits — the PR is the
  // unit and sessions are witnesses, so a commit recorded by ANY of them is
  // accounted for.
  const recorded = [
    ...new Set(sessions.flatMap((s) => s.recordedCommitShas.map(normalizeSha))),
  ];

  const normalized = prCommitShas.map(normalizeSha);
  const unrecordedShas = normalized.filter((sha) => !isRecorded(sha, recorded));

  return {
    id: "commits-from-sessions",
    status: unrecordedShas.length > 0 ? "flag" : "pass",
    class: "amber",
    matchedCommitCount: normalized.length - unrecordedShas.length,
    totalCommitCount: normalized.length,
    unrecordedShas,
  };
}

/**
 * Evaluates the displayed facts and derives the verdict.
 *
 * Verdict derivation, in precedence order:
 *   - zero confirmed sessions with pending links ⇒ `waiting` — there is
 *     nothing to judge yet, and saying so beats judging on no evidence;
 *   - any red-class fact flagged ⇒ `unverifiable` — today only a
 *     verification check-bypass is red; commit provenance stays amber;
 *   - any fact flagged ⇒ `flag`;
 *   - otherwise ⇒ `pass`, meaning every DISPLAYED fact passed — never a
 *     claim about checks that could not run (an unreadable commit list
 *     omits its fact rather than passing it).
 *
 * The caller decides whether to render at all: a PR with no confirmed and
 * no pending links never reaches this function.
 */
export function evaluateEvidence(input: EvaluateEvidenceInput): EvidenceEvaluation {
  const { sessions, pendingLinkCount, prCommitShas } = input;

  if (sessions.length === 0) {
    return { verdict: "waiting", facts: [], flaggedCount: 0, pendingLinkCount };
  }

  const assembled: EvidenceFact[] = [];
  // An empty commit list (n = 0) states nothing worth a row; an unreadable
  // one (null) must not pretend to. Both omit the fact.
  if (prCommitShas !== null && prCommitShas.length > 0) {
    assembled.push(commitProvenanceFact(sessions, prCommitShas));
  }
  assembled.push(...(input.verificationFacts ?? []));
  assembled.push(...(input.customFacts ?? []));
  assembled.push(...(input.issueAskFacts ?? []));

  const levels = input.factLevels;
  const facts = levels
    ? assembled.filter((fact) => {
        const key = levelKeyOf(fact);
        return key === null || levels.get(key) !== "off";
      })
    : assembled;
  if (input.policyError) facts.push(input.policyError);
  if (input.issueAskError) facts.push(input.issueAskError);

  const flagged = facts.filter((f) => {
    if (f.status !== "flag") return false;
    const key = levelKeyOf(f);
    return key === null || levels?.get(key) !== "info";
  });
  // The promotion rule the first slice reserved: a flagged red-class fact —
  // today, only a check-bypass — makes the PR unverifiable. Amber flags can
  // only ever ask for a look.
  const verdict: EvidenceVerdict = flagged.some((f) => f.class === "red")
    ? "unverifiable"
    : flagged.length > 0
      ? "flag"
      : "pass";

  return { verdict, facts, flaggedCount: flagged.length, pendingLinkCount };
}
