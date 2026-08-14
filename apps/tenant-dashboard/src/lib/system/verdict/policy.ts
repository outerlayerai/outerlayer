import { parse } from "yaml";
import type { FactFamily } from "./types";

/**
 * The evidence policy: which validators run on a repo's PRs and at what
 * level, plus the repo's own custom validators — parsed from versioned
 * files in the customer's repository (`.outerlayer/policy.yaml` and
 * `.outerlayer/validators/*.yaml`).
 *
 * Definitions are DATA. Parsing a policy never executes anything, and every
 * custom is a condition over facts the engine already computed — which is
 * what keeps verdicts deterministic and recomputable by anyone.
 *
 * Errors are collected, never thrown: a broken file surfaces as a visible
 * config-error row on the comment (fail loudly at load), while the intact
 * remainder of the policy still applies. Dangling names — a `validator:`
 * reference nothing defines, an `emitted:` name no validator declares, an
 * unknown preset — are load errors, not silent no-ops at check time.
 */

/** `off` removes the row entirely (the result is dropped before display);
 * `info` renders the row but its flag never counts toward the verdict;
 * `warn` is full participation. */
type PolicyLevel = "warn" | "info" | "off";

/** The one preset this engine ships. A policy naming anything else is
 * broken loudly rather than silently treated as empty. */
const RECOMMENDED_PRESET = "outerlayer:recommended@v1";

/** Built-in validator ids a policy may level and a custom may require.
 * These are the registry entries of the recommended preset; every id here
 * has an implementation in `validators.ts` / `evaluate.ts`. */
const BUILTIN_VALIDATOR_IDS = [
  "red-then-green",
  "no-test-tampering",
  "commits-from-sessions",
] as const;

const BUILTIN_ID_SET: ReadonlySet<string> = new Set(BUILTIN_VALIDATOR_IDS);

interface SessionRanCondition {
  kind: "session-ran";
  /** Matched against the classified runs' normalized command (exact or
   * word-prefix), after the same normalization the classifier applies. */
  command: string;
}

/** Built-ins a custom may `require:` — the session-fact validators only.
 * Commit provenance is computed from GitHub data the custom evaluator never
 * sees, and custom-to-custom composition needs an evaluation order that
 * does not exist yet; both are load errors, not silent unknowns. */
const REQUIRABLE_VALIDATOR_IDS = ["red-then-green", "no-test-tampering"] as const;

type RequirableValidatorId = (typeof REQUIRABLE_VALIDATOR_IDS)[number];

const REQUIRABLE_ID_SET: ReadonlySet<string> = new Set(REQUIRABLE_VALIDATOR_IDS);

interface ValidatorCondition {
  kind: "validator";
  id: RequirableValidatorId;
}

interface EmittedCondition {
  kind: "emitted";
  /** A name some validator in this policy declares via `run.emit`. The
   * delivery channel is not wired yet, so this condition evaluates as
   * unknown (suppressing the row) rather than unmet — never a false fail
   * for a result that had no way to arrive. */
  name: string;
}

export type RequireCondition = SessionRanCondition | ValidatorCondition | EmittedCondition;

interface RequireClause {
  /** `any` passes on the first satisfied condition; `all` needs every one. */
  mode: "any" | "all";
  conditions: RequireCondition[];
}

export interface CustomValidator {
  id: string;
  /** `signal` customs parse but never render — signals rank attention and
   * can never appear as a validation row (they ship in a later story). */
  kind: "validation" | "signal";
  /** The row copy, rendered verbatim on pass; a flag appends "— not
   * proven". A row may only claim what its matcher proves. */
  row: string;
  level: PolicyLevel;
  /** Path globs (`*`, `**`) against the PR's changed files. Absent means
   * the validator applies to every PR. */
  whenPaths: string[] | null;
  require: RequireClause;
  /** Fact families the conditions read — auto-derived from the conditions
   * and unioned with an explicit `needs:` list. Missing families make the
   * validator not checkable, never a false fail. */
  needs: FactFamily[];
}

interface PolicyError {
  file: string;
  message: string;
}

interface EvidencePolicy {
  /** Final display level per validator id — built-in defaults, then each
   * custom's own level, then the policy file's `validators:` overrides. */
  levels: Map<string, PolicyLevel>;
  customs: CustomValidator[];
  errors: PolicyError[];
}

export interface PolicyFile {
  path: string;
  content: string;
}

export interface PolicySource {
  policyYaml: PolicyFile | null;
  validatorFiles: PolicyFile[];
  /** Validator files past the read cap, in path order. A validator that
   * silently never evaluates is the failure mode this feature exists to
   * prevent, so the overflow becomes a load error rather than a quiet
   * omission. */
  ignoredValidatorPaths?: string[];
}

const LEVELS: ReadonlySet<string> = new Set(["warn", "info", "off"]);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const EMIT_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const MAX_ROW_LENGTH = 140;

/** More validator files than this is not a policy, it's a bulk import;
 * reads stay bounded and the overflow surfaces as a load error. */
export const MAX_VALIDATOR_FILES = 20;

const CONTROL_CHARS = /\p{Cc}/u;

/**
 * Foreign strings quoted into error messages render inside the PR comment,
 * where a newline would let policy content forge extra rows and an
 * unbounded value would flood the comment. Control characters collapse to
 * spaces and long values truncate — the quoted copy stays one honest line.
 */
export function inlineText(raw: string, max = 80): string {
  const flat = raw.replace(/\p{Cc}+/gu, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one custom-validator file. Returns the custom plus the emit names
 * it declares, or an error message; a file either contributes wholly or not
 * at all — no partially-applied validators. Emitted-name resolution happens
 * in a second pass, once every file's declarations are known. */
function parseCustomFile(
  file: PolicyFile,
): { custom: CustomValidator; declaredEmits: string[]; emittedRefs: string[] } | { error: string } {
  let doc: unknown;
  try {
    doc = parse(file.content);
  } catch (parseError) {
    return { error: `not valid YAML (${inlineText((parseError as Error).message.split("\n")[0]!)})` };
  }
  if (!isRecord(doc)) return { error: "expected a YAML mapping at the top level" };

  const id = doc["id"];
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return { error: "`id` must be a lowercase-dashed slug" };
  }
  const kind = doc["kind"] ?? "validation";
  if (kind !== "validation" && kind !== "signal") {
    return { error: `\`kind\` must be "validation" or "signal", got "${inlineText(String(kind))}"` };
  }
  const rawRow = doc["row"];
  if (typeof rawRow !== "string" || rawRow.trim().length === 0) {
    return { error: "`row` is required — it is the sentence the comment renders" };
  }
  const row = rawRow.trim();
  // The row is rendered verbatim into the comment; a newline in it could
  // forge extra rows (a fake ✓ line), so multi-line copy is a load error.
  if (CONTROL_CHARS.test(row)) {
    return { error: "`row` must be a single line without control characters" };
  }
  if (row.length > MAX_ROW_LENGTH) {
    return { error: `\`row\` is longer than ${MAX_ROW_LENGTH} characters` };
  }
  const level = doc["level"] ?? "warn";
  if (typeof level !== "string" || !LEVELS.has(level)) {
    return { error: `\`level\` must be warn, info, or off — got "${inlineText(String(level))}"` };
  }

  let whenPaths: string[] | null = null;
  if (doc["when"] !== undefined) {
    const when = doc["when"];
    if (!isRecord(when)) return { error: "`when` must be a mapping" };
    const paths = when["paths"];
    if (paths !== undefined) {
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || p.length === 0)) {
        return { error: "`when.paths` must be a list of non-empty path globs" };
      }
      whenPaths = paths as string[];
    }
    const unknownKey = Object.keys(when).find((key) => key !== "paths");
    if (unknownKey) {
      return { error: `\`when.${inlineText(unknownKey)}\` is not supported yet — only \`when.paths\`` };
    }
  }

  const declaredEmits: string[] = [];
  if (doc["run"] !== undefined) {
    const run = doc["run"];
    if (!isRecord(run) || run["where"] !== "ci" || typeof run["emit"] !== "string") {
      return { error: "`run` must be `{ where: ci, emit: <name> }`" };
    }
    if (!EMIT_NAME_PATTERN.test(run["emit"])) {
      return { error: "`run.emit` must be a dotted lowercase name (like `smoke.pass`)" };
    }
    declaredEmits.push(run["emit"]);
  }

  const requireParsed = parseRequire(doc["require"]);
  if ("error" in requireParsed) return { error: requireParsed.error };

  const needs = new Set<FactFamily>();
  for (const condition of requireParsed.clause.conditions) {
    if (condition.kind === "session-ran") needs.add("commands");
  }
  if (doc["needs"] !== undefined) {
    if (!Array.isArray(doc["needs"])) return { error: "`needs` must be a list" };
    for (const entry of doc["needs"]) {
      const family = normalizeFactFamily(entry);
      if (family === null) return { error: `\`needs\` entry "${inlineText(String(entry))}" is not a fact family` };
      needs.add(family);
    }
  }

  return {
    custom: {
      id,
      kind,
      row,
      level: level as PolicyLevel,
      whenPaths,
      require: requireParsed.clause,
      needs: [...needs],
    },
    declaredEmits,
    emittedRefs: requireParsed.clause.conditions
      .filter((condition): condition is EmittedCondition => condition.kind === "emitted")
      .map((condition) => condition.name),
  };
}

function normalizeFactFamily(entry: unknown): FactFamily | null {
  if (entry === "commands" || entry === "tool-calls.commands") return "commands";
  if (entry === "edits" || entry === "tool-calls.edits") return "edits";
  return null;
}

function parseRequire(raw: unknown): { clause: RequireClause } | { error: string } {
  if (raw === undefined) return { error: "`require` is required for a validation" };
  if (!isRecord(raw)) return { error: "`require` must be a mapping" };

  const hasAny = raw["any"] !== undefined;
  const hasAll = raw["all"] !== undefined;
  if (hasAny && hasAll) return { error: "`require` may use `any` or `all`, not both" };

  const mode: RequireClause["mode"] = hasAll ? "all" : "any";
  const rawConditions = hasAny || hasAll ? raw[mode] : [raw];
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
    return { error: `\`require.${mode}\` must be a non-empty list of conditions` };
  }

  const conditions: RequireCondition[] = [];
  for (const rawCondition of rawConditions) {
    const condition = parseCondition(rawCondition);
    if ("error" in condition) return condition;
    conditions.push(condition.condition);
  }
  return { clause: { mode, conditions } };
}

function parseCondition(raw: unknown): { condition: RequireCondition } | { error: string } {
  if (!isRecord(raw)) return { error: "each condition must be a mapping with one key" };
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    return { error: `a condition takes exactly one of session.ran / validator / emitted` };
  }
  const key = keys[0]!;
  const value = raw[key];
  if (key === "session.ran") {
    if (!isRecord(value) || typeof value["command"] !== "string" || !value["command"].trim()) {
      return { error: "`session.ran` needs a `command`" };
    }
    const status = value["status"] ?? "ok";
    if (status !== "ok") {
      return { error: `\`session.ran.status\` supports only "ok" — got "${inlineText(String(status))}"` };
    }
    const unknownKey = Object.keys(value).find((k) => k !== "command" && k !== "status");
    if (unknownKey) return { error: `\`session.ran.${inlineText(unknownKey)}\` is not supported yet` };
    return { condition: { kind: "session-ran", command: value["command"].trim() } };
  }
  if (key === "validator") {
    if (typeof value !== "string" || !REQUIRABLE_ID_SET.has(value)) {
      return {
        error: `\`validator: ${inlineText(String(value))}\` cannot be required — only red-then-green and no-test-tampering can, for now`,
      };
    }
    return { condition: { kind: "validator", id: value as RequirableValidatorId } };
  }
  if (key === "emitted") {
    if (typeof value !== "string" || !EMIT_NAME_PATTERN.test(value)) {
      return { error: "`emitted` must be a dotted lowercase name (like `smoke.pass`)" };
    }
    return { condition: { kind: "emitted", name: value } };
  }
  return { error: `"${inlineText(key)}" is not a condition — use session.ran, validator, or emitted` };
}

/**
 * Parses the whole policy source. Always returns a usable policy: files
 * that fail to parse are excluded and reported in `errors`; the built-in
 * defaults apply wherever nothing overrides them.
 */
export function parseEvidencePolicy(source: PolicySource): EvidencePolicy {
  const errors: PolicyError[] = [];
  let customs: CustomValidator[] = [];
  const declaredEmits = new Set<string>();
  const emittedRefsByFile: Array<{ file: string; customId: string; names: string[] }> = [];

  for (const file of source.validatorFiles) {
    const parsed = parseCustomFile(file);
    if ("error" in parsed) {
      errors.push({ file: file.path, message: parsed.error });
      continue;
    }
    if (
      BUILTIN_ID_SET.has(parsed.custom.id) ||
      customs.some((existing) => existing.id === parsed.custom.id)
    ) {
      errors.push({ file: file.path, message: `id "${parsed.custom.id}" is already taken` });
      continue;
    }
    customs.push(parsed.custom);
    for (const name of parsed.declaredEmits) declaredEmits.add(name);
    if (parsed.emittedRefs.length > 0) {
      emittedRefsByFile.push({ file: file.path, customId: parsed.custom.id, names: parsed.emittedRefs });
    }
  }

  // Files past the read cap were never parsed — that must fail loudly, not
  // leave a validator silently unenforced. One error covers them all.
  const ignored = source.ignoredValidatorPaths ?? [];
  if (ignored.length > 0) {
    const others = ignored.length - 1;
    errors.push({
      file: ignored[0]!,
      message:
        `not read — a policy reads at most ${MAX_VALIDATOR_FILES} validator files` +
        (others > 0 ? ` (along with ${others} more)` : ""),
    });
  }

  // Emitted names resolve against the whole policy's declarations, so the
  // check runs after every file has contributed its `run.emit` — and a
  // custom whose reference dangles is dropped wholly, matching the
  // file-contributes-wholly-or-not-at-all rule above.
  const droppedIds = new Set<string>();
  for (const { file, customId, names } of emittedRefsByFile) {
    for (const name of names) {
      if (!declaredEmits.has(name)) {
        errors.push({
          file,
          message: `\`emitted: ${name}\` — no validator declares \`run.emit: ${name}\``,
        });
        droppedIds.add(customId);
      }
    }
  }
  customs = customs.filter((custom) => !droppedIds.has(custom.id));

  const levels = new Map<string, PolicyLevel>();
  for (const id of BUILTIN_VALIDATOR_IDS) levels.set(id, "warn");
  for (const custom of customs) levels.set(custom.id, custom.level);

  if (source.policyYaml !== null) {
    applyPolicyFile(source.policyYaml, levels, customs, errors);
  }

  return { levels, customs, errors };
}

function applyPolicyFile(
  file: PolicyFile,
  levels: Map<string, PolicyLevel>,
  customs: readonly CustomValidator[],
  errors: PolicyError[],
): void {
  let doc: unknown;
  try {
    doc = parse(file.content);
  } catch (parseError) {
    errors.push({
      file: file.path,
      message: `not valid YAML (${inlineText((parseError as Error).message.split("\n")[0]!)})`,
    });
    return;
  }
  if (doc === null || doc === undefined) return;
  if (!isRecord(doc)) {
    errors.push({ file: file.path, message: "expected a YAML mapping at the top level" });
    return;
  }

  if (doc["extends"] !== undefined && doc["extends"] !== RECOMMENDED_PRESET) {
    errors.push({
      file: file.path,
      message: `unknown preset "${inlineText(String(doc["extends"]))}" — this engine ships ${RECOMMENDED_PRESET}`,
    });
  }

  const overrides = doc["validators"];
  if (overrides === undefined) return;
  if (!isRecord(overrides)) {
    errors.push({ file: file.path, message: "`validators` must map validator ids to levels" });
    return;
  }
  const knownIds = new Set<string>([...BUILTIN_VALIDATOR_IDS, ...customs.map((c) => c.id)]);
  for (const [id, level] of Object.entries(overrides)) {
    if (!knownIds.has(id)) {
      errors.push({ file: file.path, message: `\`validators.${inlineText(id)}\` does not name a validator` });
      continue;
    }
    if (typeof level !== "string" || !LEVELS.has(level)) {
      errors.push({
        file: file.path,
        message: `\`validators.${inlineText(id)}\` must be warn, info, or off — got "${inlineText(String(level))}"`,
      });
      continue;
    }
    levels.set(id, level as PolicyLevel);
  }
}
