import "server-only";

/**
 * Detect that a merged PR reverts another one in the same repo, from its
 * body text. GitHub's revert button emits a machine-readable reference:
 * "Reverts owner/repo#123" (or "Reverts #123").
 *
 * We deliberately match ONLY that explicit form, anchored to the word
 * "reverts", so an unrelated "#123" elsewhere in the body (or a squashed title
 * that happens to contain an issue reference) is not a false positive. A manual
 * `git revert` whose body carries only "This reverts commit <sha>" — no PR
 * number — is NOT resolvable to a tracked row and returns null. That is a
 * documented undercount (same honesty as reopen_count's webhook-only limit),
 * not a silent gap: the revert rate reads reverted_at IS NOT NULL, so an
 * unresolved revert leaves the target looking un-reverted.
 *
 * Returns the target PR number (the row whose `reverted_at` should be set),
 * or null when the body carries no explicit revert reference.
 */
export function parseRevertTarget(
  body: string | undefined | null
): { prNumber: number } | null {
  const b = body ?? "";
  // "Reverts <owner/repo>#N" or "Reverts #N". [^\s#]* absorbs the optional
  // owner/repo prefix without crossing whitespace, so the "#N" must
  // immediately follow the "Reverts <ref>" token.
  const match = b.match(/\bReverts\s+[^\s#]*#(\d+)\b/i);
  if (!match) return null;
  const prNumber = Number(match[1]);
  return Number.isInteger(prNumber) && prNumber > 0 ? { prNumber } : null;
}

/**
 * Revert targets named by a COMMIT MESSAGE — the manual-`git revert` path the
 * body parser above can't see (no revert PR ever exists; the revert lands as
 * a direct push). Three explicit signals, nothing looser:
 *
 *  1. A first line following the revert-title convention — `Revert "… (#N)"`
 *     — where "(#N)" is the PR reference GitHub's squash-merge appends to the
 *     reverted commit's title. Anchored to a line STARTING with `Revert` so a
 *     commit merely mentioning "(#N)" never matches; the lazy `.*?` takes the
 *     FIRST reference, which belongs to the reverted commit (a trailing
 *     "(#M)" on the same line is the revert's own PR number, when the revert
 *     itself went through a squash-merged PR).
 *  2. The body-level provider references (`Reverts owner/repo#N` /
 *     `reverts merge request !N`) — squash commit messages can carry the
 *     revert PR's body.
 *  3. `This reverts commit <sha>` — full 40-hex shas only (what `git revert`
 *     and both providers' UIs write; accepting short prefixes would let any
 *     7-hex word in a message match). Resolvable only when <sha> is a tracked
 *     row's head_sha (a squash/merge commit's sha is not stored anywhere, so
 *     reverting THOSE stays unresolvable by sha; the title path above is what
 *     usually catches them).
 *
 * Returns every distinct PR/MR number and full-or-abbreviated sha named. The
 * caller decides what a number/sha maps to (and applies base-branch and
 * merged-state guards — this function only parses).
 */
export function parseCommitRevertTargets(message: string | undefined | null): {
  prNumbers: number[];
  shas: string[];
} {
  const text = message ?? "";
  const prNumbers = new Set<number>();
  const shas = new Set<string>();

  const firstLine = text.split("\n", 1)[0] ?? "";
  const titleMatch = firstLine.match(/^Revert\b.*?\(#(\d+)\)/i);
  if (titleMatch) {
    const n = Number(titleMatch[1]);
    if (Number.isInteger(n) && n > 0) prNumbers.add(n);
  }

  const bodyTarget = parseRevertTarget(text);
  if (bodyTarget) prNumbers.add(bodyTarget.prNumber);

  for (const m of text.matchAll(/\bThis reverts commit ([0-9a-f]{40})\b/gi)) {
    shas.add(m[1]!.toLowerCase());
  }

  return { prNumbers: [...prNumbers], shas: [...shas] };
}
