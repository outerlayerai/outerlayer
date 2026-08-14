import { parse as parseYaml } from "yaml";

import type { FactFamily } from "./types";

/**
 * The policy layer's contracts and parser: `.outerlayer/policy.yaml` adopts
 * and levels the built-in registry, and `.outerlayer/validators/*.yaml` files
 * declare custom validators as conditions over facts the engine already
 * computed. Everything here is pure string-and-data work — parsing a
 * validator never executes anything, reads no filesystem, and never touches
 * the network, which is what keeps verdicts deterministic and recomputable
 * by anyone from the same files.
 *
 * Failure posture: broken config fails loudly at load, never silently at
 * check time. Every problem is collected with the file it came from; a file
 * (or a cross-reference) with a problem contributes no validator, and the
 * caller renders a visible error row instead of quietly checking less.
 */

type PolicyLevel = "warn" | "info" | "off";

/** One load-time config problem, attributed to the file that carries it. */
export interface PolicyProblem {
  file: string;
  problem: string;
}

/** A single provable condition — one alternative of a `require:`. */
export type RequirementAlt =
  /** A classified command run matching `command` (normalized-prefix) with
   * the given span exit status. */
  | { type: "session-ran"; command: string; status: "ok" | "error" }
  /** Another validator's result by id — built-in or custom. */
  | { type: "validator"; id: string }
  /** An emitted result recorded for this PR under a declared name. */
  | { type: "emitted"; name: string };

export interface CustomValidatorDef {
  id: string;
  /** The row copy, rendered verbatim (escaped) — it may only claim what the
   * matcher proves, so the parser caps and single-lines it but never
   * rewrites it. */
  row: string;
  level: PolicyLevel;
  /** Path globs scoping the validator to PRs whose diff touches them; null
   * means the validator applies to every PR. */
  whenPaths: readonly string[] | null;
  /** Alternatives — the requirement is satisfied when ANY alternative is. */
  requireAny: readonly RequirementAlt[];
  /** Fact families the author declares the rule reads. A family the capture
   * didn't cover makes the validator not checkable; a `session.ran`
   * alternative is additionally guarded per-alternative at evaluation, so an
   * uncaptured command channel can never silently pass even undeclared. */
  needs: readonly FactFamily[];
  /** The emit name this validator declares (`run: {where: ci, emit: …}`);
   * names are declarations, never vocabulary — an `emitted:` requirement
   * anywhere in the policy must reference one of these. */
  declaresEmit: string | null;
}

export interface LoadedPolicy {
  /** Effective level per validator id — registry defaults, then file-declared
   * custom levels, then policy-file overrides, in that order. */
  levels: Readonly<Record<string, PolicyLevel>>;
  /** Surviving custom validators, sorted by id so downstream evaluation and
   * rendering are order-independent of file layout. */
  customs: readonly CustomValidatorDef[];
  problems: readonly PolicyProblem[];
}

/** The one registry a policy may extend. Its members are the checks the
 * comment renders with no policy file at all, so "no policy" and
 * "extends: recommended, no overrides" are the same behavior by
 * construction. */
const RECOMMENDED_EXTENDS = "outerlayer:recommended@v1";

export const RECOMMENDED_LEVELS: Readonly<Record<string, PolicyLevel>> = {
  "commits-from-sessions": "warn",
  "red-then-green": "warn",
  "no-test-tampering": "warn",
};

/** Built-ins a custom's `require.validator` may reference: the fact-layer
 * validators, including the silent one (silent means "renders no row", not
 * "feeds no composition"). Commit provenance computes outside the fact
 * layer, so referencing it is a load error rather than a runtime unknown. */
const REFERENCEABLE_BUILTINS: ReadonlySet<string> = new Set([
  "red-then-green",
  "no-test-tampering",
  "tests-after-last-edit",
]);

/** Ids and emit names share the artifact id vocabulary — id characters only,
 * so a stored value can never carry markdown, spaces, or HTML into a
 * rendered surface. */
const SLUG_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/** Row copy ceiling — a row is one sentence, not a paragraph, and the
 * comment renderer must never inherit an unbounded tenant-authored string. */
const MAX_ROW_LENGTH = 200;

/** Fact-family spellings accepted in `needs:`. The namespaced forms are the
 * validator format's own vocabulary; the bare forms are the engine's. */
const NEEDS_ALIASES: Readonly<Record<string, FactFamily>> = {
  "tool-calls.commands": "commands",
  "tool-calls.edits": "edits",
  commands: "commands",
  edits: "edits",
};

export function defaultPolicy(): LoadedPolicy {
  return { levels: { ...RECOMMENDED_LEVELS }, customs: [], problems: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLevel(value: unknown): PolicyLevel | null {
  return value === "warn" || value === "info" || value === "off" ? value : null;
}

interface ParsedFile {
  path: string;
  content: string;
}

interface PolicyFileResult {
  extendsOk: boolean;
  /** id → level overrides, applied only when the file as a whole parsed. */
  overrides: Record<string, PolicyLevel>;
  problems: PolicyProblem[];
}

/**
 * Parses `.outerlayer/policy.yaml`. Any problem voids the file's overrides
 * wholesale — a policy that half-applied would be harder to reason about
 * than one that visibly failed — but never the recommended defaults, so the
 * comment still renders today's checks alongside the error row.
 */
function parsePolicyFile(file: ParsedFile): PolicyFileResult {
  const problems: PolicyProblem[] = [];
  const fail = (problem: string): PolicyFileResult => {
    problems.push({ file: file.path, problem });
    return { extendsOk: false, overrides: {}, problems };
  };

  let root: unknown;
  try {
    root = parseYaml(file.content);
  } catch (error) {
    return fail(`not valid YAML — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(root)) return fail("must be a YAML mapping");

  for (const key of Object.keys(root)) {
    if (key !== "extends" && key !== "validators") {
      return fail(`unknown key "${key}"`);
    }
  }

  if (root["extends"] === undefined) {
    return fail(`missing "extends" — adopt the registry with extends: ${RECOMMENDED_EXTENDS}`);
  }
  if (root["extends"] !== RECOMMENDED_EXTENDS) {
    return fail(
      `unknown extends "${String(root["extends"])}" — the only supported registry is ${RECOMMENDED_EXTENDS}`,
    );
  }

  const overrides: Record<string, PolicyLevel> = {};
  const validators = root["validators"];
  if (validators !== undefined) {
    if (!isRecord(validators)) return fail(`"validators" must be a mapping of id to level`);
    for (const [id, rawLevel] of Object.entries(validators)) {
      const level = parseLevel(rawLevel);
      if (level === null) {
        return fail(`validator "${id}" has level "${String(rawLevel)}" — use warn, info, or off`);
      }
      overrides[id] = level;
    }
  }

  return { extendsOk: true, overrides, problems };
}

interface ParsedCustom {
  def: CustomValidatorDef;
  file: string;
  /** Kept out of `requireAny` until cross-file resolution proves the names —
   * a dangling reference drops the whole validator, loudly. */
  validatorRefs: string[];
  emittedRefs: string[];
}

function parseSessionRan(
  value: unknown,
  file: string,
  problems: PolicyProblem[],
): RequirementAlt | null {
  if (!isRecord(value)) {
    problems.push({ file, problem: `"session.ran" must be a mapping with a "command"` });
    return null;
  }
  for (const key of Object.keys(value)) {
    if (key !== "command" && key !== "status") {
      problems.push({ file, problem: `"session.ran" has unknown key "${key}"` });
      return null;
    }
  }
  const command = value["command"];
  if (typeof command !== "string" || command.trim() === "") {
    problems.push({ file, problem: `"session.ran" needs a non-empty "command"` });
    return null;
  }
  const status = value["status"] ?? "ok";
  if (status !== "ok" && status !== "error") {
    problems.push({ file, problem: `"session.ran" status must be ok or error` });
    return null;
  }
  return { type: "session-ran", command: command.trim(), status };
}

/** One `require:` alternative — a single-key mapping naming the condition. */
function parseRequirementAlt(
  value: unknown,
  file: string,
  problems: PolicyProblem[],
): RequirementAlt | null {
  if (!isRecord(value)) {
    problems.push({ file, problem: `each requirement must be a single-key mapping` });
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    problems.push({
      file,
      problem: `a requirement names exactly one of session.ran, validator, emitted`,
    });
    return null;
  }
  const key = keys[0]!;
  if (key === "session.ran") return parseSessionRan(value[key], file, problems);
  if (key === "validator") {
    const id = value[key];
    if (typeof id !== "string" || !SLUG_PATTERN.test(id)) {
      problems.push({ file, problem: `"validator" must name a validator id` });
      return null;
    }
    return { type: "validator", id };
  }
  if (key === "emitted") {
    const name = value[key];
    if (typeof name !== "string" || !SLUG_PATTERN.test(name)) {
      problems.push({ file, problem: `"emitted" must name an emit (id characters only)` });
      return null;
    }
    return { type: "emitted", name };
  }
  problems.push({ file, problem: `unknown requirement "${key}"` });
  return null;
}

function parseRequire(
  value: unknown,
  file: string,
  problems: PolicyProblem[],
): RequirementAlt[] | null {
  if (isRecord(value) && "any" in value) {
    if (Object.keys(value).length !== 1 || !Array.isArray(value["any"]) || value["any"].length === 0) {
      problems.push({ file, problem: `"require.any" must be a non-empty list of requirements` });
      return null;
    }
    const alts: RequirementAlt[] = [];
    for (const entry of value["any"]) {
      const alt = parseRequirementAlt(entry, file, problems);
      if (alt === null) return null;
      alts.push(alt);
    }
    return alts;
  }
  const single = parseRequirementAlt(value, file, problems);
  return single === null ? null : [single];
}

function parseNeeds(value: unknown, file: string, problems: PolicyProblem[]): FactFamily[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push({ file, problem: `"needs" must be a list of fact families` });
    return null;
  }
  const families: FactFamily[] = [];
  for (const entry of value) {
    const family = typeof entry === "string" ? NEEDS_ALIASES[entry] : undefined;
    if (family === undefined) {
      problems.push({ file, problem: `unknown fact family "${String(entry)}" in "needs"` });
      return null;
    }
    families.push(family);
  }
  return families;
}

const CUSTOM_KEYS = new Set(["id", "kind", "row", "level", "when", "require", "run", "needs"]);

/**
 * Parses one `.outerlayer/validators/*.yaml` file. Returns null (with
 * problems recorded) when anything about it is off — a validator either
 * loads whole or not at all.
 *
 * `kind:` is enforced here at the earliest possible moment: a `signal` is
 * accepted as a file (its id still occupies the namespace) but yields no
 * definition, so nothing downstream can ever render it as a validation row.
 */
function parseCustomFile(
  file: ParsedFile,
  problems: PolicyProblem[],
): ParsedCustom | { signalId: string } | null {
  const fail = (problem: string): null => {
    problems.push({ file: file.path, problem });
    return null;
  };

  let root: unknown;
  try {
    root = parseYaml(file.content);
  } catch (error) {
    return fail(`not valid YAML — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(root)) return fail("must be a YAML mapping");

  for (const key of Object.keys(root)) {
    if (!CUSTOM_KEYS.has(key)) return fail(`unknown key "${key}"`);
  }

  const id = root["id"];
  if (typeof id !== "string" || !SLUG_PATTERN.test(id)) {
    return fail(`"id" must be lowercase id characters (got ${JSON.stringify(root["id"])})`);
  }

  const kind = root["kind"];
  if (kind !== "validation" && kind !== "signal") {
    return fail(`"${id}" has kind "${String(kind)}" — use validation or signal`);
  }
  if (kind === "signal") return { signalId: id };

  const row = root["row"];
  if (typeof row !== "string" || row.trim() === "") {
    return fail(`"${id}" needs a "row" — the sentence its result renders as`);
  }
  if (row.includes("\n") || row.length > MAX_ROW_LENGTH) {
    return fail(`"${id}" row must be a single line of at most ${MAX_ROW_LENGTH} characters`);
  }

  const level = root["level"] === undefined ? "warn" : parseLevel(root["level"]);
  if (level === null) {
    return fail(`"${id}" has level "${String(root["level"])}" — use warn, info, or off`);
  }

  let whenPaths: string[] | null = null;
  if (root["when"] !== undefined) {
    const when = root["when"];
    if (!isRecord(when) || Object.keys(when).some((key) => key !== "paths")) {
      return fail(`"${id}" when: only "paths" scoping is supported`);
    }
    const paths = when["paths"];
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((p) => typeof p !== "string" || p.trim() === "")
    ) {
      return fail(`"${id}" when.paths must be a non-empty list of path globs`);
    }
    whenPaths = paths.map((p: string) => p.trim());
  }

  const hasRequire = root["require"] !== undefined;
  const hasRun = root["run"] !== undefined;
  if (hasRequire === hasRun) {
    return fail(`"${id}" must declare exactly one of "require" or "run"`);
  }

  let requireAny: RequirementAlt[];
  let declaresEmit: string | null = null;
  if (hasRun) {
    const run = root["run"];
    if (!isRecord(run) || Object.keys(run).some((key) => key !== "where" && key !== "emit")) {
      return fail(`"${id}" run: must be a mapping of "where" and "emit"`);
    }
    if (run["where"] !== "ci") {
      return fail(`"${id}" run.where must be ci — the engine never executes customer code`);
    }
    const emit = run["emit"];
    if (typeof emit !== "string" || !SLUG_PATTERN.test(emit)) {
      return fail(`"${id}" run.emit must name the emit (id characters only)`);
    }
    declaresEmit = emit;
    requireAny = [{ type: "emitted", name: emit }];
  } else {
    const parsed = parseRequire(root["require"], file.path, problems);
    if (parsed === null) return null;
    requireAny = parsed;
  }

  const declaredNeeds = parseNeeds(root["needs"], file.path, problems);
  if (declaredNeeds === null) return null;

  return {
    def: {
      id,
      row: row.trim(),
      level,
      whenPaths,
      requireAny,
      // Declared needs only — the author's own statement of what the rule
      // reads. A session.ran alternative is guarded per-alternative at
      // evaluation regardless, so an uncaptured command channel can never
      // silently pass; deriving it here would additionally blind an `any:`
      // whose OTHER alternative (an emitted result) could still answer.
      needs: [...new Set<FactFamily>(declaredNeeds)].sort(),
      declaresEmit,
    },
    file: file.path,
    validatorRefs: requireAny.flatMap((alt) => (alt.type === "validator" ? [alt.id] : [])),
    emittedRefs: requireAny.flatMap((alt) => (alt.type === "emitted" ? [alt.name] : [])),
  };
}

/**
 * Drops every custom whose references don't resolve, to fixpoint: a dropped
 * validator takes its emit declaration with it, which can invalidate a
 * requiring validator in turn. Cycles among `validator:` references starve
 * (neither member ever resolves) and are reported as unresolvable.
 */
function resolveReferences(
  parsed: ParsedCustom[],
  signalIds: ReadonlySet<string>,
  problems: PolicyProblem[],
): ParsedCustom[] {
  let surviving = parsed;
  for (;;) {
    const ids = new Set([...REFERENCEABLE_BUILTINS, ...surviving.map((p) => p.def.id)]);
    const emits = new Set(
      surviving.flatMap((p) => (p.def.declaresEmit === null ? [] : [p.def.declaresEmit])),
    );
    const next = surviving.filter((candidate) => {
      for (const ref of candidate.validatorRefs) {
        // Self-reference can never resolve; it would otherwise survive the
        // fixpoint (its own id is in `ids`) and evaluate as a cycle of one.
        if (ref === candidate.def.id || !ids.has(ref) || signalIds.has(ref)) {
          problems.push({
            file: candidate.file,
            problem: `"${candidate.def.id}" requires validator "${ref}" — ${
              signalIds.has(ref)
                ? "a signal can never satisfy a validation"
                : ref in RECOMMENDED_LEVELS
                  ? "that built-in cannot be referenced"
                  : "no such validator exists"
            }`,
          });
          return false;
        }
      }
      for (const name of candidate.emittedRefs) {
        if (!emits.has(name)) {
          problems.push({
            file: candidate.file,
            problem: `"${candidate.def.id}" requires emitted "${name}" but no validator declares emit: ${name}`,
          });
          return false;
        }
      }
      return true;
    });
    if (next.length === surviving.length) return dropCycles(next, problems);
    surviving = next;
  }
}

/** Validator-reference cycles can't be evaluated (neither result exists
 * first), so every member of one is dropped with a problem naming it. */
function dropCycles(parsed: ParsedCustom[], problems: PolicyProblem[]): ParsedCustom[] {
  const byId = new Map(parsed.map((p) => [p.def.id, p]));
  const state = new Map<string, "visiting" | "done">();
  const cyclic = new Set<string>();

  const visit = (id: string, stack: string[]): void => {
    const entry = byId.get(id);
    if (!entry || state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      for (const member of stack.slice(stack.indexOf(id))) cyclic.add(member);
      return;
    }
    state.set(id, "visiting");
    for (const ref of entry.validatorRefs) visit(ref, [...stack, id]);
    state.set(id, "done");
  };
  for (const p of parsed) visit(p.def.id, []);

  return parsed.filter((p) => {
    if (!cyclic.has(p.def.id)) return true;
    problems.push({
      file: p.file,
      problem: `"${p.def.id}" is part of a validator-reference cycle and cannot be evaluated`,
    });
    return false;
  });
}

/**
 * Parses the whole policy: the policy file (or null when the repo has none)
 * plus every validator file, cross-checked. Deterministic: files process in
 * sorted-path order and customs come back sorted by id, so identical inputs
 * load an identical policy regardless of directory listing order.
 */
export function parsePolicy(
  policyFile: ParsedFile | null,
  validatorFiles: readonly ParsedFile[],
): LoadedPolicy {
  const problems: PolicyProblem[] = [];

  const policy = policyFile
    ? parsePolicyFile(policyFile)
    : { extendsOk: true, overrides: {}, problems: [] as PolicyProblem[] };
  problems.push(...policy.problems);

  const parsed: ParsedCustom[] = [];
  const signalIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const file of [...validatorFiles].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const result = parseCustomFile(file, problems);
    if (result === null) continue;
    const id = "signalId" in result ? result.signalId : result.def.id;
    const collidesWithBuiltin = id in RECOMMENDED_LEVELS || REFERENCEABLE_BUILTINS.has(id);
    if (seenIds.has(id) || collidesWithBuiltin) {
      problems.push({
        file: file.path,
        problem: collidesWithBuiltin
          ? `"${id}" collides with a built-in validator id`
          : `duplicate validator id "${id}"`,
      });
      continue;
    }
    seenIds.add(id);
    if ("signalId" in result) signalIds.add(id);
    else parsed.push(result);
  }

  // Two validators declaring one emit name would make "which check does this
  // emit satisfy" ambiguous; first (by sorted path) wins, later ones drop.
  const emitOwners = new Map<string, string>();
  const deduped = parsed.filter((p) => {
    if (p.def.declaresEmit === null) return true;
    const owner = emitOwners.get(p.def.declaresEmit);
    if (owner === undefined) {
      emitOwners.set(p.def.declaresEmit, p.def.id);
      return true;
    }
    problems.push({
      file: p.file,
      problem: `"${p.def.id}" declares emit "${p.def.declaresEmit}" already declared by "${owner}"`,
    });
    return false;
  });

  const resolved = resolveReferences(deduped, signalIds, problems);
  const customs = resolved.map((p) => p.def).sort((a, b) => (a.id < b.id ? -1 : 1));

  const levels: Record<string, PolicyLevel> = { ...RECOMMENDED_LEVELS };
  for (const custom of customs) levels[custom.id] = custom.level;
  for (const [id, level] of Object.entries(policy.overrides)) {
    if (!(id in levels) && !signalIds.has(id)) {
      problems.push({
        file: policyFile?.path ?? ".outerlayer/policy.yaml",
        problem: `policy levels unknown validator "${id}"`,
      });
      continue;
    }
    // A signal has no row to level; the entry is inert but not an error —
    // the file that declared the signal already established it exists.
    if (!signalIds.has(id)) levels[id] = level;
  }

  return { levels, customs, problems };
}
