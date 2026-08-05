/**
 * Repo scoping for cloud sync.
 *
 * Even at `redacted` tier a synced session carries repo + branch identity —
 * enough to leak client names and personal projects into a company tenant.
 * `repos.include` / `repos.exclude` in ~/.outerlayer/config.json scope what
 * leaves the machine, matched against the session's normalized git remote
 * (`github.com/org/repo`):
 *
 *   { "repos": { "exclude": ["gitlab.com/personal/*"] } }
 *   { "repos": { "include": ["github.com/agentmark-ai/*"] } }
 *
 * Rules (exclude wins over include):
 *   - exclude: drop any session whose repo matches a pattern.
 *   - include (when non-empty): keep ONLY sessions whose repo matches; a
 *     session with no detectable repo is dropped too — unknown origin is not
 *     provably in scope.
 *   - neither set: everything syncs (current behavior).
 *
 * A session skipped by the filter is NOT tracked for later: the sync
 * watermark still advances past it, so loosening the filter only picks up
 * old sessions via `sync --all`.
 */

export interface RepoFilterConfig {
  include?: string[];
  exclude?: string[];
}

/** `*` wildcard → regex, everything else literal, case-insensitive. */
function toMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export class RepoFilter {
  private readonly include: RegExp[];
  private readonly exclude: RegExp[];
  /** Sessions dropped, keyed by repo (or "(no repo)") — for the sync summary. */
  readonly skipped = new Map<string, number>();

  constructor(config: RepoFilterConfig | undefined) {
    this.include = (config?.include ?? []).map(toMatcher);
    this.exclude = (config?.exclude ?? []).map(toMatcher);
  }

  get active(): boolean {
    return this.include.length > 0 || this.exclude.length > 0;
  }

  /** True when the session should sync. Records skips for reporting. */
  allows(repo: string | undefined): boolean {
    const label = repo || "(no repo)";
    if (repo && this.exclude.some((m) => m.test(repo))) {
      this.skipped.set(label, (this.skipped.get(label) ?? 0) + 1);
      return false;
    }
    if (this.include.length > 0 && !(repo && this.include.some((m) => m.test(repo)))) {
      this.skipped.set(label, (this.skipped.get(label) ?? 0) + 1);
      return false;
    }
    return true;
  }

  get skippedTotal(): number {
    let n = 0;
    for (const c of this.skipped.values()) n += c;
    return n;
  }
}
