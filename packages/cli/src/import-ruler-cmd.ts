// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * `outerlayer import ruler`: ports a `.ruler/` tree (Ruler,
 * https://github.com/intellectronica/ruler, MIT-licensed — the per-target
 * destination matrix this whole compile-out format adapts from) into the
 * equivalent `.outerlayer/` tree at the same scope. Mostly a rename: our
 * layout deliberately mirrors AGENTS.md + mcp.json, so this port is close to
 * 1:1. Ruler has no subagent kind, so
 * this importer never writes `.outerlayer/agents/`. Never overwrites an
 * existing `.outerlayer/` — that's a hard refusal, nothing written, not a
 * merge.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizePath } from "@outerlayer/context-format";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export class ImportRulerError extends Error {}

export interface ImportRulerCommandOptions {
  /** Repo root to read from (default: `process.cwd()`). */
  cwd?: string;
  quiet?: boolean;
  json?: boolean;
}

type ImportRulerWarningCode = "ruler_toml_not_imported" | "unmapped_file";

interface ImportRulerWarning {
  code: ImportRulerWarningCode;
  path: string;
  message: string;
}

interface ImportedScope {
  /** Repo-relative scope path (`''` = repo root), mirroring `ClassifiedEntry.scopePath`. */
  scopePath: string;
  agentsMdWritten?: string;
  mcpWritten?: string;
}

export interface ImportRulerCommandResult {
  scopes: ImportedScope[];
  warnings: ImportRulerWarning[];
  output: string;
  exitCode: 0 | 1;
}

function toRepoRelative(base: string, name: string): string {
  return normalizePath(`${base}/${name}`);
}

/** Every directory literally named `.ruler`, skipping `node_modules`/`.git`.
 * Does not descend past a found `.ruler/` looking for a nested one — Ruler's
 * own layout has no such concept. */
function discoverRulerDirs(repoRoot: string): string[] {
  const out: string[] = [];
  walk(repoRoot, repoRoot, "", out);
  return out.sort();
}

function walk(dirAbs: string, repoRoot: string, dirRel: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const childRel = dirRel === "" ? entry.name : toRepoRelative(dirRel, entry.name);
    if (entry.name === ".ruler") {
      out.push(childRel);
      continue;
    }
    walk(join(dirAbs, entry.name), repoRoot, childRel, out);
  }
}

/** Files only, recursively — used to catalog anything under a `.ruler/`
 * subdirectory (not itself part of the binding mapping) so nothing is
 * silently invisible; every path found surfaces as an `unmapped_file` warning. */
function collectFilesRecursively(dirAbs: string, dirRel: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childRel = toRepoRelative(dirRel, entry.name);
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) out.push(...collectFilesRecursively(childAbs, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

interface RulerCatalog {
  agentsMd?: string;
  /** Other root `.md` files, filename-sorted, excluding `AGENTS.md`. */
  otherMd: Array<{ filename: string; content: string }>;
  mcpJson?: string;
  rulerTomlPath?: string;
  /** Repo-relative paths of everything else under this `.ruler/` — never silently dropped. */
  unmapped: string[];
}

/** Direct children of one `.ruler/` dir, classified per the binding import
 * mapping. A subdirectory isn't part of that mapping (Ruler's layout has
 * none in practice) — its files are cataloged as unmapped, not skipped. */
function catalogRulerDir(repoRoot: string, rulerDirRel: string): RulerCatalog {
  const abs = join(repoRoot, rulerDirRel);
  const catalog: RulerCatalog = { otherMd: [], unmapped: [] };
  const mdFilenames: string[] = [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childRel = toRepoRelative(rulerDirRel, entry.name);
    if (entry.isDirectory()) {
      catalog.unmapped.push(...collectFilesRecursively(join(abs, entry.name), childRel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === "AGENTS.md") catalog.agentsMd = readFileSync(join(abs, entry.name), "utf8");
    else if (entry.name === "mcp.json") catalog.mcpJson = readFileSync(join(abs, entry.name), "utf8");
    else if (entry.name === "ruler.toml") catalog.rulerTomlPath = childRel;
    else if (entry.name.endsWith(".md")) mdFilenames.push(entry.name);
    else catalog.unmapped.push(childRel);
  }

  catalog.otherMd = mdFilenames
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({ filename, content: readFileSync(join(abs, filename), "utf8") }));

  return catalog;
}

/** `.ruler` (dir) → its parent's scope path (`''` at repo root), matching
 * `ClassifiedEntry.scopePath` conventions. */
function scopeOf(rulerDirRel: string): string {
  if (rulerDirRel === ".ruler") return "";
  return rulerDirRel.slice(0, rulerDirRel.length - "/.ruler".length);
}

function outerlayerDirFor(scopePath: string): string {
  return scopePath === "" ? ".outerlayer" : `${scopePath}/.outerlayer`;
}

function writeOutFile(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function renderSuccess(scopes: ImportedScope[], warnings: ImportRulerWarning[]): string {
  const warningSuffix = warnings.length > 0 ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "";
  const lines = [`${GREEN}✓${RESET} imported ${scopes.length} .ruler/ scope${scopes.length === 1 ? "" : "s"}${warningSuffix}`];
  for (const s of scopes) {
    const written = [s.agentsMdWritten, s.mcpWritten].filter((p): p is string => p !== undefined);
    lines.push(`  ${DIM}${s.scopePath === "" ? "(root)" : s.scopePath}${RESET} → ${written.join(", ") || "nothing to import"}`);
  }
  return lines.join("\n");
}

export function runImportRuler(opts: ImportRulerCommandOptions = {}): ImportRulerCommandResult {
  const cwd = opts.cwd ?? process.cwd();
  if (!existsSync(cwd)) throw new ImportRulerError(`no such directory: ${cwd}`);

  const rulerDirs = discoverRulerDirs(cwd);

  if (rulerDirs.length === 0) {
    const output = opts.json
      ? JSON.stringify({ scopes: [], warnings: [] })
      : `${DIM}no .ruler/ directories found — nothing to import${RESET}`;
    if (!opts.quiet) process.stdout.write(output + "\n");
    return { scopes: [], warnings: [], output, exitCode: 0 };
  }

  // Hard refusal, checked for every scope BEFORE any write: never overwrite
  // an existing .outerlayer/. All-or-nothing — a conflict anywhere aborts
  // the whole import, not just the conflicting scope.
  const conflicts = rulerDirs
    .map((rel) => outerlayerDirFor(scopeOf(rel)))
    .filter((outerlayerRel) => existsSync(join(cwd, outerlayerRel)));
  if (conflicts.length > 0) {
    throw new ImportRulerError(
      `refusing to import — .outerlayer/ already exists at: ${conflicts.join(", ")} (never overwritten; remove it first to replace it)`,
    );
  }

  const scopes: ImportedScope[] = [];
  const warnings: ImportRulerWarning[] = [];

  for (const rulerDirRel of rulerDirs) {
    const scopePath = scopeOf(rulerDirRel);
    const outerlayerRel = outerlayerDirFor(scopePath);
    const catalog = catalogRulerDir(cwd, rulerDirRel);
    const scope: ImportedScope = { scopePath };

    if (catalog.agentsMd !== undefined || catalog.otherMd.length > 0) {
      let content = catalog.agentsMd ?? "";
      for (const { filename, content: mdContent } of catalog.otherMd) {
        content += `\n\n<!-- imported from .ruler/${filename} -->\n\n${mdContent}`;
      }
      const agentsPath = toRepoRelative(outerlayerRel, "AGENTS.md");
      writeOutFile(cwd, agentsPath, content);
      scope.agentsMdWritten = agentsPath;
    }

    if (catalog.mcpJson !== undefined) {
      const mcpPath = toRepoRelative(outerlayerRel, "mcp.json");
      writeOutFile(cwd, mcpPath, catalog.mcpJson);
      scope.mcpWritten = mcpPath;
    }

    if (catalog.rulerTomlPath !== undefined) {
      warnings.push({
        code: "ruler_toml_not_imported",
        path: catalog.rulerTomlPath,
        message: `${catalog.rulerTomlPath} was not imported — target selection now lives in .outerlayer/config.json; per-tool config is superseded`,
      });
    }

    for (const path of catalog.unmapped) {
      warnings.push({ code: "unmapped_file", path, message: `${path} has no .outerlayer/ equivalent — not imported` });
    }

    scopes.push(scope);
  }

  warnings.sort((a, b) => a.path.localeCompare(b.path));

  const output = opts.json ? JSON.stringify({ scopes, warnings }) : renderSuccess(scopes, warnings);

  if (!opts.quiet) {
    if (opts.json) {
      process.stdout.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
      for (const w of warnings) process.stderr.write(`  ${YELLOW}!${RESET} ${w.path}: ${w.message}\n`);
    }
  }

  return { scopes, warnings, output, exitCode: 0 };
}
