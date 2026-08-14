import type { CommandKind, SuiteScope } from "./types";

/**
 * Command normalization + classification — the single place raw shell
 * strings become facts. Real commands arrive wrapped (`cd x && npx …`, env
 * prefixes, yarn scripts), and every validator's correctness rests on this
 * file, so it is deliberately small, table-driven, and fixture-tested.
 *
 * Two rules govern additions:
 *  - Classification must stay conservative: an unrecognized command is
 *    `other`, and an unproven suite scope is `unknown` — misclassifying
 *    toward `test`/`full` is how a row ends up claiming more than its
 *    matcher proved.
 *  - Everything here is pure string work. No filesystem, no config reads —
 *    org-configurable patterns arrive later as *data* passed in, not as
 *    lookups performed here.
 */

/** Claude Code's Bash tool serializes input as JSON (`{"command": …}`);
 * other adapters may hand over the raw string. Accept both; anything else
 * yields no command rather than a guess. */
export function extractCommandText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const command = (parsed as Record<string, unknown>)["command"];
        return typeof command === "string" && command.trim() ? command.trim() : null;
      }
      return null;
    } catch {
      // Not JSON after all — fall through and treat it as a plain command.
    }
  }
  return text;
}

/**
 * Strips the wrappers that vary between invocations of the same command:
 * leading `cd … &&`, environment assignments, and runner prefixes
 * (`npx`/`yarn`/`pnpm`/`bunx` and their silence flags). What remains is the
 * stable identity used to say "this is the SAME command that failed
 * earlier" — red-then-green's grouping key.
 */
export function normalizeCommand(command: string): string {
  let out = command.trim().replace(/\s+/g, " ");
  // Peel `cd path &&` prefixes (possibly repeated).
  for (;;) {
    const next = out.replace(/^cd\s+[^&;|]+(?:&&|;)\s*/, "");
    if (next === out) break;
    out = next.trim();
  }
  // Peel leading VAR=value assignments.
  out = out.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "");
  // Peel runner prefixes; keep the script/binary they invoke.
  out = out.replace(/^(?:npx|bunx)\s+(?:--yes\s+|-y\s+)?/, "");
  out = out.replace(/^(?:yarn|pnpm)\s+(?:run\s+)?/, "");
  return out.trim();
}

const BYPASS_PATTERN = /(?:^|\s)(?:--no-verify(?:\s|$)|HUSKY=0)/;

/** True when a git command carries a hook-bypass flag. Matched on the RAW
 * command, not the normalized one: `HUSKY=0 git push` normalizes its env
 * prefix away, and the bypass must still be seen. Quoted segments are
 * stripped first so a commit MESSAGE that mentions `--no-verify` never
 * red-flags a PR — this check accuses; it gets no false positives. */
export function hasBypassFlag(rawCommand: string): boolean {
  const unquoted = rawCommand.replace(/'[^']*'|"[^"]*"/g, "");
  return BYPASS_PATTERN.test(unquoted) && /(?:^|\s|\/)git\s/.test(` ${unquoted}`);
}

interface KindRule {
  kind: CommandKind;
  pattern: RegExp;
}

/** First match wins; ordering is part of the table's meaning (migrations
 * before generic runners, vcs before anything that might shell out to git). */
const KIND_RULES: readonly KindRule[] = [
  { kind: "migration", pattern: /\bsupabase\s+(?:migration|db)\b/ },
  { kind: "vcs", pattern: /^git\s|\bgh\s+(?:pr|api|issue)\b/ },
  { kind: "test", pattern: /^(?:vitest|jest|playwright)\b/ },
  { kind: "test", pattern: /^(?:ci:unit|test(?::\w+)?)\b/ },
  { kind: "test", pattern: /^turbo\s+run\s+test\b/ },
  { kind: "lint", pattern: /^(?:eslint|ci:lint|lint(?::\w+)?|knip|prettier)\b/ },
  { kind: "build", pattern: /^(?:tsc|turbo\s+run\s+build|build(?::\w+)?|next\s+build)\b/ },
];

/** Suite runs that cover everything, per this repo's canonical entry points.
 * A test command that names paths or filters is `partial` by construction. */
const FULL_SUITE_PATTERN = /^(?:ci:unit\b|turbo\s+run\s+test\b|test\b$|vitest\s+run$|jest$)/;
const PARTIAL_MARKERS = /\s(?:-t|--testNamePattern|--grep)\s|\s\S*\.(?:test|spec)\.\S+|\s(?:src|apps|packages)\//;

interface ClassifiedCommand {
  normalized: string;
  kind: CommandKind;
  suiteScope: SuiteScope;
  bypass: boolean;
}

export function classifyCommand(rawCommand: string): ClassifiedCommand {
  const normalized = normalizeCommand(rawCommand);
  let kind: CommandKind = "other";
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(normalized)) {
      kind = rule.kind;
      break;
    }
  }
  let suiteScope: SuiteScope = "unknown";
  if (kind === "test") {
    if (PARTIAL_MARKERS.test(` ${normalized}`)) suiteScope = "partial";
    else if (FULL_SUITE_PATTERN.test(normalized)) suiteScope = "full";
  }
  return { normalized, kind, suiteScope, bypass: hasBypassFlag(rawCommand) };
}

/** The pairing identity for "the same command ran again": everything from
 * the first pipe onward and trailing stderr redirects are presentation, not
 * identity — `… | tail -25` on the failing run and `… | tail -5` on the
 * rerun must pair. */
export function commandPairKey(normalized: string): string {
  return normalized.split(" | ")[0]!.replace(/\s*2>&1\s*$/, "").trim();
}

const OUTPUT_FAIL = /(?:^|\s)[1-9]\d*\s+fail(?:ed)?\b/;
const OUTPUT_PASS = /\b\d+\s+pass(?:ed)?\b/;

/**
 * Reliable outcome of a test run. Output is the primary source because piped
 * commands mask exit codes (`vitest … | tail` exits with tail's status — a
 * REAL failing run in this repo's own history recorded `ok`). Exit status is
 * trusted only for unpiped commands; a piped run with inconclusive output is
 * honestly unknown, and validators must not anchor anything on it.
 */
export function detectTestResult(
  normalized: string,
  exitStatus: "ok" | "error" | "rejected",
  output: string | undefined,
): "pass" | "fail" | undefined {
  if (output) {
    if (OUTPUT_FAIL.test(output)) return "fail";
    if (OUTPUT_PASS.test(output)) return "pass";
  }
  const piped = normalized.includes(" | ");
  if (piped) return undefined;
  if (exitStatus === "error") return "fail";
  if (exitStatus === "ok") return "pass";
  return undefined;
}

/**
 * Real commands are compounds: `cd x && python3 - <<'EOF' … EOF && yarn
 * vitest run … | tail`. Classifying only the first token buries the test
 * run — a REAL passing rerun in this repo's history classified `other`
 * because the compound started with a heredoc. So classification is
 * segment-aware: heredoc bodies are stripped first (their CONTENT must
 * never classify — a script that mentions `vitest run` in a string is not
 * a test run), then the command splits on statement separators and each
 * segment classifies independently.
 */
export function splitCommandSegments(rawCommand: string): string[] {
  const noHeredocs = rawCommand.replace(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?[\s\S]*?\n\1\b/g, "");
  return noHeredocs
    .split(/&&|;|\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Test-file naming this repo (and most JS/TS repos) uses. Kept as data so
 * org-configurable globs can replace it without touching callers. */
const TEST_FILE_PATTERN = /(?:\.test\.|\.spec\.|__tests__\/|(?:^|\/)tests?\/)/;

export function isTestFilePath(file: string): boolean {
  return TEST_FILE_PATTERN.test(file);
}
