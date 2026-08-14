import type { CustomValidationFact, IssueAskErrorFact, IssueAskFact, VerificationFact } from "./evaluate";
import type { PrArtifactRow } from "./artifacts-read";

/**
 * The issue side of the evidence comment: a linked issue's "Validation
 * required" checklist becomes required-evidence rows on the PR.
 *
 * Exactly one structured thing in an issue body produces requirements — the
 * checklist under a "Validation required" heading, written by a human at
 * spec time. Free prose never becomes a requirement, and nothing an issue
 * says can disable a validator, change a level, or suppress a row: this
 * module only ever ADDS facts. The worst a hostile issue edit can do is
 * demand extra proof.
 *
 * Entry grammar, one per checklist line:
 *   - `validator-id`      — a validator from the repo's registry; the row
 *                           reports whether its result proved out.
 *   - `<kind>: <label>`   — a typed proof (screenshot, video, …) satisfied
 *                           by an artifact of that kind anchored to the PR.
 * A checkbox's checked state is ignored — evidence decides, not ticks.
 *
 * Dangling asks (an unknown validator id, an unknown proof kind) fail
 * loudly as one error row, exactly like a broken policy file.
 */

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  typeName: string | null;
}

type IssueAsk =
  | { kind: "validator"; validatorId: string; issueNumber: number }
  | { kind: "proof"; proofKind: string; label: string; issueNumber: number };

interface IssueAskError {
  issueNumber: number;
  entry: string;
  message: string;
}

const BLOCK_HEADING = /^#{1,6}\s+validation required\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const CHECKLIST_ITEM = /^[-*]\s+\[[ xX]\]\s+(.+)$/;
const VALIDATOR_ENTRY = /^[a-z][a-z0-9-]*$/;
const PROOF_ENTRY = /^([a-z]+):\s*(.+)$/;

interface ParsedIssueAsks {
  asks: IssueAsk[];
  errors: IssueAskError[];
}

export function parseIssueAsks(
  issues: readonly LinkedIssue[],
  knownValidatorIds: ReadonlySet<string>,
  proofKinds: ReadonlySet<string>,
): ParsedIssueAsks {
  const asks: IssueAsk[] = [];
  const errors: IssueAskError[] = [];

  for (const issue of issues) {
    let inBlock = false;
    for (const rawLine of issue.body.split("\n")) {
      const line = rawLine.trim();
      if (BLOCK_HEADING.test(line)) {
        inBlock = true;
        continue;
      }
      if (inBlock && ANY_HEADING.test(line)) inBlock = false;
      if (!inBlock) continue;
      const item = CHECKLIST_ITEM.exec(line);
      if (!item) continue;
      const entry = item[1]!.trim();

      const proof = PROOF_ENTRY.exec(entry);
      if (proof) {
        const [, kind, label] = proof;
        if (!proofKinds.has(kind!)) {
          errors.push({
            issueNumber: issue.number,
            entry,
            message: `"${kind}" is not a proof kind`,
          });
          continue;
        }
        // `test` proofs bind by criterion id, which an issue entry does not
        // carry — an ask that could never be satisfied is an error, not a
        // permanent amber row.
        if (kind === "test") {
          errors.push({
            issueNumber: issue.number,
            entry,
            message: "test proofs bind by criterion id — declare them in the spec file",
          });
          continue;
        }
        asks.push({ kind: "proof", proofKind: kind!, label: label!.trim(), issueNumber: issue.number });
        continue;
      }
      if (VALIDATOR_ENTRY.test(entry)) {
        if (!knownValidatorIds.has(entry)) {
          errors.push({
            issueNumber: issue.number,
            entry,
            message: `"${entry}" does not name a validator`,
          });
          continue;
        }
        asks.push({ kind: "validator", validatorId: entry, issueNumber: issue.number });
        continue;
      }
      errors.push({
        issueNumber: issue.number,
        entry,
        message: "an entry is a validator id or `<kind>: <label>`",
      });
    }
  }

  return { asks, errors };
}

/**
 * Asks → displayed facts. A validator ask is proven by that validator's own
 * pass among the evaluated results (computed BEFORE display leveling, so a
 * policy `off` cannot mute an issue's ask); anything else — flagged,
 * absent, not evaluated — is "not proven", which claims only that the
 * proof is missing, never that the work is wrong. A proof ask is proven by
 * any artifact of the required kind anchored to the PR.
 */
export function issueAskFacts(
  parsed: ParsedIssueAsks,
  verification: readonly VerificationFact[],
  customs: readonly CustomValidationFact[],
  artifacts: readonly Pick<PrArtifactRow, "kind">[],
): { facts: IssueAskFact[]; error: IssueAskErrorFact | null } {
  const facts: IssueAskFact[] = [];
  for (const ask of parsed.asks) {
    if (ask.kind === "validator") {
      const result =
        verification.find((fact) => fact.id === ask.validatorId) ??
        customs.find((fact) => fact.validatorId === ask.validatorId);
      const proven = result?.status === "pass";
      facts.push({
        id: "issue-ask",
        status: proven ? "pass" : "flag",
        class: "amber",
        sentence: proven
          ? `The issue asked for \`${ask.validatorId}\` — proven`
          : `The issue asked for \`${ask.validatorId}\` — not proven`,
        issueNumber: ask.issueNumber,
        refs: proven && result ? result.refs : [],
      });
      continue;
    }
    const attached = artifacts.some((artifact) => artifact.kind === ask.proofKind);
    facts.push({
      id: "issue-ask",
      status: attached ? "pass" : "flag",
      class: "amber",
      sentence: attached
        ? `${ask.label} — ${ask.proofKind} attached`
        : `${ask.label} — ${ask.proofKind} required, none attached`,
      issueNumber: ask.issueNumber,
      refs: [],
    });
  }

  let error: IssueAskErrorFact | null = null;
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]!;
    const remainder = parsed.errors.length - 1;
    error = {
      id: "issue-ask-error",
      status: "flag",
      class: "amber",
      message:
        `#${first.issueNumber} "${first.entry}" — ${first.message}` +
        (remainder > 0 ? ` (and ${remainder} more)` : ""),
    };
  }
  return { facts, error };
}
