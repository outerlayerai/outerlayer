/**
 * Criterion proof requirements for the comment's Evidence section.
 *
 * The spec is the source: a criterion in `acceptance/NNN-*.md` declares the
 * form its proof must take by annotating its id — ``` `AC-084-11`
 * (proof: screenshot) ``` — and this module reads those declarations from the
 * PR's own changed acceptance files at the PR head. The renderer then holds
 * bound artifacts against them: right kind → proof link; wrong kind →
 * "video required · screenshot attached"; nothing bound → "video required ·
 * none attached". Scoping to files the PR touches is what keeps a repo's
 * whole criteria catalog from rendering on every PR.
 *
 * `parseProofCriteria` is pure; `fetchPrProofCriteria` owns the GitHub reads
 * and is best-effort — a failure degrades the comment to artifacts-only
 * rather than blocking it.
 */

export interface CriterionRequirement {
  id: string;
  proofKind: string;
}

/** Kinds a criterion may require — the artifact-kind vocabulary. The parser
 * ignores unknown kinds rather than rendering a requirement it could never
 * match. */
const PROOF_KINDS = new Set(["video", "screenshot", "report", "log", "file"]);

const PROOF_ANNOTATION = /`(AC-\d{3}-\d{2})`\s*\(proof:\s*([a-z]+)\)/g;

/** Hard cap on distinct proof declarations a parse yields. The source is
 * the PR's own head content — attacker-influenceable — and every parsed
 * criterion becomes a comment table row, so an unbounded parse lets a
 * stuffed acceptance file grow the comment without limit. First
 * declarations in document order win, matching the duplicate rule. */
const MAX_PROOF_CRITERIA = 100;

/** Every `` `AC-NNN-NN` (proof: <kind>) `` declaration in an acceptance
 * file's markdown (capped at {@link MAX_PROOF_CRITERIA} distinct ids), first
 * declaration winning on a duplicated id, sorted by id so downstream
 * rendering is order-independent of file layout. */
export function parseProofCriteria(markdown: string): CriterionRequirement[] {
  const byId = new Map<string, string>();
  for (const match of markdown.matchAll(PROOF_ANNOTATION)) {
    if (byId.size >= MAX_PROOF_CRITERIA) break;
    const [, id, kind] = match;
    if (!id || !kind || !PROOF_KINDS.has(kind)) continue;
    if (!byId.has(id)) byId.set(id, kind);
  }
  return [...byId.entries()]
    .map(([id, proofKind]) => ({ id, proofKind }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const ACCEPTANCE_FILE = /^acceptance\/\d{3}-.*\.md$/;
/** A PR touching more acceptance files than this is bulk-moving specs, not
 * declaring proofs; content reads stay bounded. */
const MAX_ACCEPTANCE_FILES = 5;

/** The one provider read this module performs — `GitHubProvider` satisfies
 * it structurally; only `content` is consumed. The changed-file list is a
 * parameter, not a fetch: the orchestrator already reads it once for the
 * verification facts and both consumers must see the same list. */
interface ProofCriteriaSource {
  getFileContent(repo: string, path: string, ref: string): Promise<{ content: string }>;
}

/**
 * Proof requirements declared in acceptance files this PR touches, read at
 * the PR's own head ref (`refs/pull/<n>/head` — always the head sha without
 * a second PR lookup). Returns [] when the PR touches none. Throws on
 * provider errors — the caller degrades to artifacts-only rendering.
 */
export async function fetchPrProofCriteria(
  github: ProofCriteriaSource,
  repo: string,
  prNumber: number,
  changedFiles: { filename: string; changeStatus: string }[],
): Promise<CriterionRequirement[]> {
  const acceptancePaths = changedFiles
    .filter((f) => f.changeStatus !== "removed" && ACCEPTANCE_FILE.test(f.filename))
    .map((f) => f.filename)
    .slice(0, MAX_ACCEPTANCE_FILES);
  if (acceptancePaths.length === 0) return [];

  const headRef = `refs/pull/${prNumber}/head`;
  const requirements: CriterionRequirement[] = [];
  for (const path of acceptancePaths) {
    const file = await github.getFileContent(repo, path, headRef);
    requirements.push(...parseProofCriteria(file.content));
  }
  const byId = new Map<string, string>();
  for (const { id, proofKind } of requirements) {
    // The same cap the per-file parse enforces, applied across files —
    // earlier files win, deterministically.
    if (byId.size >= MAX_PROOF_CRITERIA) break;
    if (!byId.has(id)) byId.set(id, proofKind);
  }
  return [...byId.entries()]
    .map(([id, proofKind]) => ({ id, proofKind }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
