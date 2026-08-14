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
 * The one fact this slice computes. A discriminated union from day one so
 * the next validator lands as a new member, not a refactor.
 */
export type EvidenceFact = CommitProvenanceFact;

interface CommitProvenanceFact {
  id: "commits-from-sessions";
  /** `flag` when any PR commit matched no recorded session commit. */
  status: "pass" | "flag";
  /** Amber can flag the verdict; only a red-class fact may ever produce
   * "unverifiable". No red-class fact exists in this slice, so that verdict
   * is currently unreachable — deliberately, per the story. */
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
 *   - any red-class fact flagged ⇒ `unverifiable` (unreachable in this
 *     slice — commit provenance is amber, and it is the only fact);
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

  const facts: EvidenceFact[] = [];
  // An empty commit list (n = 0) states nothing worth a row; an unreadable
  // one (null) must not pretend to. Both omit the fact.
  if (prCommitShas !== null && prCommitShas.length > 0) {
    facts.push(commitProvenanceFact(sessions, prCommitShas));
  }

  const flagged = facts.filter((f) => f.status === "flag");
  // No red-class fact exists in this slice, so "unverifiable" is never
  // DERIVED here — deliberately not a dead `class === "red"` branch that no
  // input can reach. The verdict type and the renderer's red copy stay ahead
  // of it, so the first red-class fact lands as a promotion rule beside the
  // fact itself, not as a copy change.
  const verdict: EvidenceVerdict = flagged.length > 0 ? "flag" : "pass";

  return { verdict, facts, flaggedCount: flagged.length, pendingLinkCount };
}
