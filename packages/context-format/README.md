# @outerlayer/context-format

The `.outerlayer/` context format: a path-based tree classifier, frontmatter
parsing, and the emit engine that compiles a classified tree into each coding
agent's native files (Claude Code, Cursor, Codex, Copilot, Factory), plus
`.outerlayer/config.json` parsing.

Pure library — no `fs`, no network, no clock, no environment reads — so the
same code runs unchanged in a CLI, a server, or a bundled client.

## Install

```bash
npm install @outerlayer/context-format
```

## The idea

You write agent context once, under `.outerlayer/`. Each tool wants it
somewhere else, in a slightly different shape. This package turns the one
source tree into every tool's native layout, deterministically:

```
.outerlayer/AGENTS.md          →  CLAUDE.md          (Claude Code)
                               →  AGENTS.md          (Cursor, Codex, Copilot, Factory)
.outerlayer/skills/<name>/     →  .claude/skills/<name>/
                               →  .agents/skills/<name>/
.outerlayer/commands/<ns>/x.md →  .claude/commands/<ns>/x.md
                               →  .cursor/commands/<ns>/x.md
.outerlayer/mcp.json           →  .mcp.json  /  .cursor/mcp.json
```

A `.outerlayer/` directory can sit at the repo root or in any subdirectory.
The directory it sits in is that tree's **scope**, and outputs are written
relative to the same scope, so a monorepo can carry per-package context.

## Usage

```ts
import {
  classifyTree,
  emitTree,
  parseOuterlayerConfig,
  parseContextFile,
} from "@outerlayer/context-format";

// 1. Classify: paths in, kinds out. No file is read — you supply the paths.
const { entries, issues, excludedCounts } = classifyTree([
  ".outerlayer/AGENTS.md",
  ".outerlayer/skills/deploy/SKILL.md",
  ".outerlayer/commands/ship.md",
]);

// 2. Read the target opt-in from .outerlayer/config.json.
const parsed = parseOuterlayerConfig('{"targets":["claude-code","cursor"]}');
if (!parsed.ok) throw new Error(parsed.errors[0].message);

// 3. Emit: you supply the contents, you get files back. Still no I/O.
const result = emitTree({
  entries,
  contents: new Map([
    [".outerlayer/AGENTS.md", "# House rules\n"],
    [".outerlayer/skills/deploy/SKILL.md", "---\nname: deploy\n---\nSteps…\n"],
    [".outerlayer/commands/ship.md", "---\ndescription: ship it\n---\nRun the release.\n"],
  ]),
  targets: parsed.config!.targets,
  assetPaths: [],
});

for (const file of result.files) await writeFile(file.path, file.content);
for (const copy of result.copies) await copyFile(copy.fromSourcePath, copy.toPath);
```

`emitTree` returns `{ files, copies, warnings, errors }`. Text output is in
`files`; binary and asset passthrough is in `copies`, as a
`{ fromSourcePath, toPath }` instruction — the emitter never touches bytes it
would have to read from disk, so the caller owns every filesystem operation.

## Key concepts

**Classification is by location, never by content.** `classifyTree` decides
what a file is from where it sits, and it always runs over the whole path list
rather than one path at a time, because shadowing and skill grouping need the
global view. The kinds are `instructions`, `skill`, `skill-reference`,
`command`, `reference`, `mcp`, `subagent`, `folder`, and
`external-instructions` — the last being a `CLAUDE.md` or `AGENTS.md` that
lives *outside* `.outerlayer/` and is therefore read-only: it is reported to
you, but it is never a source for emit.

**Problems are returned, not thrown.** `classifyTree` reports `issues`
(`missing-skill-md`, `shadowed`, `misplaced`), and `emitTree` returns
`warnings` and `errors` as data. `parseContextFile` never throws either —
malformed frontmatter resolves to `frontmatter: null` rather than an
exception, so one bad file cannot fail a whole tree.

**Targets are opt-in.** There is no default target set: an empty `targets`
array is a hard `no_targets` error, and so is an unrecognised target id in
`.outerlayer/config.json`. Emitting into a tool's directories is a decision
the repo makes explicitly.

**Overlapping targets merge, conflicts refuse.** Several targets emit the same
root `AGENTS.md`; identical content at one path dedups into a single file. If
two targets ever produce *different* content at the same path, that is a
`path_conflict` error and **no file is written** — never last-writer-wins.

**Output is deterministic.** Files are sorted by path and contain no dates,
versions, or environment values, so two runs over the same input are
byte-identical. Generated markdown carries a header pointing at its source
file; JSON outputs do not, since JSON has no comment syntax.

**`CLASSIFIER_VERSION`** is exported so a caller that caches classification
results can invalidate them: the constant is bumped whenever a change would
classify an unchanged tree differently.

## Environment references

`${VAR}` and `${VAR:-default}` are parsed by `findEnvRefs` and rewritten
per-target by `rewriteEnvRefs`. Cursor's MCP output uses this to rewrite
`${VAR}` into Cursor's own `${env:VAR}` form, via the exported
`cursorEnvRefRewrite`.

## Current coverage

Claude Code and Cursor receive instructions, skills, skill references,
commands, and MCP config. Codex, Copilot, and Factory currently receive
`AGENTS.md` instructions only; any other emittable kind present in the source
produces one warning per kind rather than a partial, misleading emit. The
`reference` and `subagent` kinds are classified but not yet emitted by any
target.

## Tests

```bash
yarn test        # vitest, no sandbox or network required
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
