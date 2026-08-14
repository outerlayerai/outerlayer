import { normalizeCommand } from "./classify";
import type { CustomValidatorDef, RequirementAlt } from "./policy";
import type { CommandRun, Facts, RuleResult } from "./types";

/**
 * Evaluates custom validators over the same fact layer the built-ins read.
 * Pure and deterministic — same definitions, facts, diff, emitted records,
 * and built-in results in, same results out — because a custom is only ever
 * a condition over things the engine already proved; nothing here executes,
 * reads clocks, or touches I/O.
 *
 * Display doctrine, inherited rather than re-implemented:
 *  - a `when:` scope that didn't match produces NO result at all;
 *  - a validator whose `needs` families weren't captured is `not_checkable`
 *    — never a silent pass and never a false fail;
 *  - a satisfied requirement passes with the proof that satisfied it (the
 *    matched run's position, or the emitted record's source);
 *  - user checks cap at amber structurally: no code path here can mark a
 *    result red-class.
 */

/** The latest emitted result recorded for a PR under one declared name. */
export interface EmittedResultRecord {
  name: string;
  result: "pass" | "fail";
  link: string;
  provenance: "ci" | "local";
}

export interface CustomRuleResult {
  id: string;
  status: "pass" | "flag" | "not_checkable";
  /** The definition's row copy, verbatim. */
  row: string;
  level: "warn" | "info";
  /** Timeline positions backing the result — same shape as built-in refs. */
  refs: Array<{ sessionIndex: number; turnIndex: number | null }>;
  /** Present when an emitted result decided the outcome — where it came
   * from and the run it links. */
  source: { provenance: "ci" | "local"; link: string } | null;
}

interface EvaluateCustomsInput {
  defs: readonly CustomValidatorDef[];
  facts: Facts;
  /** The PR's changed file paths; null means the list could not be read,
   * which conservatively suppresses every path-scoped validator — the same
   * "never approximate the diff" posture as red-then-green. */
  changedPaths: readonly string[] | null;
  emitted: ReadonlyMap<string, EmittedResultRecord>;
  builtinResults: ReadonlyMap<string, Pick<RuleResult, "status" | "refs">>;
}

/**
 * Glob → regex for `when.paths`. Supports `**` (any depth), `*` (within one
 * segment), and `?`; everything else matches literally. Anchored both ends —
 * a glob names paths, not substrings.
 */
export function pathGlobToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * Whether a matcher's command names this run. Both sides go through the same
 * normalization the classifier applies, so wrapper prefixes (`cd x &&`,
 * `npx`, env assignments) never defeat a match — and the match is
 * whole-word-prefix, so `command: "playwright"` matches `playwright test e2e`
 * while never matching `playwright-report-server`.
 */
function commandMatchesRun(matcherCommand: string, run: CommandRun): boolean {
  const wanted = normalizeCommand(matcherCommand);
  if (wanted === "") return false;
  return run.normalized === wanted || run.normalized.startsWith(`${wanted} `);
}

type AltOutcome =
  | { kind: "pass"; refs: CustomRuleResult["refs"]; source: CustomRuleResult["source"] }
  | { kind: "fail"; source: CustomRuleResult["source"] }
  | { kind: "not_checkable" };

function evaluateAlt(
  alt: RequirementAlt,
  input: EvaluateCustomsInput,
  customResults: ReadonlyMap<string, CustomRuleResult>,
): AltOutcome {
  switch (alt.type) {
    case "session-ran": {
      if (!input.facts.coverage.has("commands")) return { kind: "not_checkable" };
      const match = input.facts.runs.find(
        (run) => run.status === alt.status && commandMatchesRun(alt.command, run),
      );
      if (!match) return { kind: "fail", source: null };
      return {
        kind: "pass",
        refs: [{ sessionIndex: match.sessionIndex, turnIndex: match.turnIndex }],
        source: null,
      };
    }
    case "validator": {
      // Parse-time resolution guarantees the id exists and custom→custom
      // references are acyclic, so evaluation order (sorted, DFS on refs)
      // has always produced the referenced result by the time it is read.
      const referenced =
        input.builtinResults.get(alt.id) ??
        (customResults.has(alt.id)
          ? { status: customResults.get(alt.id)!.status, refs: customResults.get(alt.id)!.refs }
          : undefined);
      if (referenced === undefined || referenced.status === "not_checkable") {
        return { kind: "not_checkable" };
      }
      // Requiring a validator converts its absence into a failure: "absent"
      // is honest silence for an opportunistic check, but a policy that
      // REQUIRES the proof is exactly a demand that it exist.
      if (referenced.status !== "pass") return { kind: "fail", source: null };
      return { kind: "pass", refs: [...referenced.refs], source: null };
    }
    case "emitted": {
      const record = input.emitted.get(alt.name);
      // The emitted-record channel is always checkable — the store was read;
      // an empty answer means the check never reported, which is a failure
      // of the requirement, not an unknown.
      if (record === undefined) return { kind: "fail", source: null };
      const source = { provenance: record.provenance, link: record.link };
      if (record.result !== "pass") return { kind: "fail", source };
      return { kind: "pass", refs: [], source };
    }
    default: {
      const exhaustive: never = alt;
      void exhaustive;
      return { kind: "not_checkable" };
    }
  }
}

function evaluateDef(
  def: CustomValidatorDef,
  input: EvaluateCustomsInput,
  customResults: ReadonlyMap<string, CustomRuleResult>,
): CustomRuleResult | null {
  if (def.level === "off") return null;

  if (def.whenPaths !== null) {
    // An unreadable diff suppresses rather than guesses; a non-matching diff
    // means the validator simply doesn't apply to this PR.
    if (input.changedPaths === null) return null;
    const patterns = def.whenPaths.map(pathGlobToRegExp);
    const applies = input.changedPaths.some((path) =>
      patterns.some((pattern) => pattern.test(path)),
    );
    if (!applies) return null;
  }

  const base = { id: def.id, row: def.row, level: def.level };

  if (!def.needs.every((family) => input.facts.coverage.has(family))) {
    return { ...base, status: "not_checkable", refs: [], source: null };
  }

  // Any-of: the first passing alternative carries the proof. No pass and
  // every alternative blind → not checkable; no pass with at least one
  // checkable alternative → flag (the requirement was checkable and unmet).
  const outcomes = def.requireAny.map((alt) => evaluateAlt(alt, input, customResults));
  const pass = outcomes.find((outcome) => outcome.kind === "pass");
  if (pass && pass.kind === "pass") {
    return { ...base, status: "pass", refs: pass.refs, source: pass.source };
  }
  if (outcomes.every((outcome) => outcome.kind === "not_checkable")) {
    return { ...base, status: "not_checkable", refs: [], source: null };
  }
  const failWithSource = outcomes.find(
    (outcome) => outcome.kind === "fail" && outcome.source !== null,
  );
  return {
    ...base,
    status: "flag",
    refs: [],
    source: failWithSource?.kind === "fail" ? failWithSource.source : null,
  };
}

/**
 * Evaluates every definition, in dependency order (a validator that
 * references another evaluates after it — parse-time resolution guarantees
 * the reference graph is acyclic). Results come back sorted by id, matching
 * the definitions' own order, so rendering is deterministic.
 */
export function evaluateCustomValidators(input: EvaluateCustomsInput): CustomRuleResult[] {
  const byId = new Map(input.defs.map((def) => [def.id, def]));
  const results = new Map<string, CustomRuleResult>();
  const evaluated = new Set<string>();

  const visit = (def: CustomValidatorDef): void => {
    if (evaluated.has(def.id)) return;
    evaluated.add(def.id);
    for (const alt of def.requireAny) {
      if (alt.type !== "validator") continue;
      const dep = byId.get(alt.id);
      if (dep) visit(dep);
    }
    const result = evaluateDef(def, input, results);
    if (result !== null) results.set(def.id, result);
  };
  for (const def of input.defs) visit(def);

  return [...results.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
