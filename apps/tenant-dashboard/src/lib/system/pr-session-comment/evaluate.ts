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
 * The policy-era members carry a `type` discriminant because their ids are
 * tenant-authored (any string), not a closed literal set.
 */
export type EvidenceFact =
  | CommitProvenanceFact
  | VerificationFact
  | CustomValidationFact
  | PolicyErrorFact;

/** Levels a policy may assign to a rendered fact. `off` never reaches a
 * fact — an off validator is filtered before its fact exists. Absent means
 * `warn` (facts recorded before policies existed carry no level). */
type FactLevel = "warn" | "info";

/**
 * A custom validator's displayed result — evaluated by the verdict layer
 * (`verdict/custom.ts`) from tenant-authored definitions, over the same
 * facts the built-ins read. `class` is structurally `"amber"`: no custom
 * validator can produce the red "can't verify" verdict, which stays
 * reserved for the tamper-class built-ins.
 */
export interface CustomValidationFact {
  type: "custom-validation";
  /** The definition's id — tenant-authored, id characters only. */
  id: string;
  /** `not_checkable` renders as a row (unlike built-ins, whose absence is
   * honest silence): a policy REQUIRES this check, so "could not check"
   * must be visible — never a silent pass, never a false fail. */
  status: "pass" | "flag" | "not_checkable";
  class: "amber";
  level: FactLevel;
  /** The definition's `row:` copy, verbatim. Escaped by the renderer — it
   * is tenant-authored and lands in a world-readable comment. */
  sentence: string;
  refs: Array<{ traceId: string; turnIndex: number | null }>;
  /** Present when an emitted result decided the outcome — where the check
   * ran and the run it links. */
  source: { provenance: "ci" | "local"; link: string } | null;
}

/**
 * The single "policy file has an error" row: broken config fails loudly at
 * load. One fact regardless of how many problems loaded — the row names the
 * first and counts the rest — and it flags at warn so a broken policy is
 * always worth a look, while the rest of the comment still renders under
 * the recommended defaults.
 */
export interface PolicyErrorFact {
  type: "policy-error";
  status: "flag";
  class: "amber";
  file: string;
  problem: string;
  additionalProblemCount: number;
}

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
  /** Policy-assigned level; absent means `warn`. */
  level?: FactLevel;
  /** The design's row copy, verbatim from the validator. */
  sentence: string;
  /** Timeline positions backing the result — turn numbers within the trace
   * they belong to, for "· turn N" suffixes and future deep links. */
  refs: Array<{ traceId: string; turnIndex: number | null }>;
}

interface CommitProvenanceFact {
  id: "commits-from-sessions";
  /** `flag` when any PR commit matched no recorded session commit. */
  status: "pass" | "flag";
  /** Amber can flag the verdict; only a red-class fact may ever produce
   * "unverifiable" (reachable since the verification facts landed — a
   * check-bypass is red; provenance stays amber by design). */
  class: "amber" | "red";
  /** Policy-assigned level; absent means `warn`. */
  level?: FactLevel;
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
  /** Effective per-validator levels from the base-branch policy. Applied
   * here — `off` removes the fact entirely, `info` stamps it — so the
   * recorded evaluation stores exactly what the policy made visible. Absent
   * (or an id with no entry) means `warn`, today's behavior. */
  factLevels?: Readonly<Record<string, "warn" | "info" | "off">>;
  /** Custom validators' displayed results, already evaluated and leveled
   * (an `off` custom never produced a result). Appended after the built-in
   * facts, in the id order the evaluator established. */
  customFacts?: readonly CustomValidationFact[];
  /** The single policy-load error, when config was broken. Appended last so
   * it never displaces a real check's row. */
  policyError?: PolicyErrorFact | null;
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
/** A fact's effective level. Policy-era facts carry it; stored pre-policy
 * facts (and the policy-error row itself) default to `warn`. */
function levelOf(fact: EvidenceFact): FactLevel {
  return "level" in fact && fact.level !== undefined ? fact.level : "warn";
}

/** Applies the policy's level to one built-in fact: `off` removes it,
 * `info` stamps it, `warn` (or no entry) leaves it untouched. */
function leveled<F extends CommitProvenanceFact | VerificationFact>(
  fact: F,
  factLevels: EvaluateEvidenceInput["factLevels"],
): F | null {
  const level = factLevels?.[fact.id] ?? "warn";
  if (level === "off") return null;
  return level === "info" ? { ...fact, level } : fact;
}

export function evaluateEvidence(input: EvaluateEvidenceInput): EvidenceEvaluation {
  const { sessions, pendingLinkCount, prCommitShas } = input;

  if (sessions.length === 0) {
    return { verdict: "waiting", facts: [], flaggedCount: 0, pendingLinkCount };
  }

  const facts: EvidenceFact[] = [];
  // An empty commit list (n = 0) states nothing worth a row; an unreadable
  // one (null) must not pretend to. Both omit the fact.
  if (prCommitShas !== null && prCommitShas.length > 0) {
    const provenance = leveled(commitProvenanceFact(sessions, prCommitShas), input.factLevels);
    if (provenance !== null) facts.push(provenance);
  }
  for (const fact of input.verificationFacts ?? []) {
    const applied = leveled(fact, input.factLevels);
    if (applied !== null) facts.push(applied);
  }
  facts.push(...(input.customFacts ?? []));
  if (input.policyError) facts.push(input.policyError);

  // Info-level facts render but never move the verdict — the level exists
  // exactly so a team can keep a check visible without it gating anything.
  const flagged = facts.filter((f) => f.status === "flag" && levelOf(f) !== "info");
  // The promotion rule the first slice reserved: a flagged red-class fact —
  // today, only a check-bypass — makes the PR unverifiable. Amber flags can
  // only ever ask for a look; custom facts are amber structurally, so no
  // user check can reach "unverifiable".
  const verdict: EvidenceVerdict = flagged.some((f) => f.class === "red")
    ? "unverifiable"
    : flagged.length > 0
      ? "flag"
      : "pass";

  return { verdict, facts, flaggedCount: flagged.length, pendingLinkCount };
}
