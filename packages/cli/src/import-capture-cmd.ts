// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * `outerlayer import capture`: installs the evidence capture pack into a
 * repo's `.outerlayer/` source tree — the `emitting-evidence` skill (for
 * harnesses that read skills) plus an AGENTS.md snippet (for harnesses that
 * don't), so agents in the repo know when and how to run
 * `outerlayer emit artifact`. `outerlayer emit` then compiles the pack into
 * each configured tool's native files.
 *
 * Write rules:
 *  - An existing skill with LOCAL EDITS is a hard refusal — nothing written,
 *    never a merge. A byte-identical skill is this command's own earlier
 *    (possibly partial) install, so the run resumes: missing files install,
 *    existing ones are left untouched.
 *  - `.outerlayer/AGENTS.md` gets the snippet APPENDED only when it already
 *    exists without the marker line. It is never created here: a fresh
 *    `.outerlayer/AGENTS.md` would make the next `outerlayer emit`
 *    overwrite a hand-written root CLAUDE.md/AGENTS.md (emit writes target
 *    files unconditionally).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export class ImportCaptureError extends Error {}

export interface ImportCaptureCommandOptions {
  /** Repo root to write into (default: `process.cwd()`). */
  cwd?: string;
  quiet?: boolean;
  json?: boolean;
}

export interface ImportCaptureCommandResult {
  /** Repo-relative paths written (created files only — an AGENTS.md append
   * is reported via `appendedAgentsMd`, not here). */
  files: string[];
  appendedAgentsMd: boolean;
  output: string;
}

const SKILL_PATH = ".outerlayer/skills/emitting-evidence/SKILL.md";
const SNIPPET_PATH = ".outerlayer/skills/emitting-evidence/references/agents-snippet.md";
const AGENTS_MD_PATH = ".outerlayer/AGENTS.md";

/** Guards the AGENTS.md append: present means the pack (or a hand-carried
 * copy of its snippet) is already there, so a re-run appends nothing. */
const AGENTS_MD_MARKER = "<!-- outerlayer:capture-pack -->";

const SKILL_CONTENT = `---
name: emitting-evidence
description: >
  Emit artifacts — screenshots, recordings, reports, logs — as proof that a
  change works, bound to the pull request via \`outerlayer emit artifact\`.
  Use when finishing work on an acceptance criterion, when a criterion
  declares a required proof form (e.g. "proof: video"), when asked to
  "provide evidence", "attach a screenshot", or "prove it works", and in CI
  steps that produce verifiable output.
---

An artifact is an exhibit: evidence *of* a specific change, anchored to the
pull request and rendered in its evidence comment. Emit the few exhibits the
spec asks for — a reviewer should see the change working, not a gallery.

## When to capture

Capture AFTER the state exists, never before: run the app, the test, or the
flow first, and shoot the working result. A screenshot of code is not
evidence; a screenshot of the rendered page is. If the state takes setup
(seed data, a logged-in user), finish the setup, verify by eye, then capture.

## Per-kind mechanics

Kind is inferred from the file's media type — name files honestly. Every
artifact shares one upload cap of 8 MiB, whatever its kind:

- **screenshot** (\`.png\`, \`.jpg\`) — one focused window or region showing the
  proven state. Crop noise; keep enough chrome (URL bar, test summary line)
  to show it is real.
- **video** (\`.webm\`, \`.mp4\`) — a short recording of the flow, start to
  outcome. Video is the kind most likely to hit the 8 MiB cap: trim dead
  time, prefer webm.
- **report** (\`.html\`, \`.pdf\`) — generated reports: coverage, benchmark,
  audit output. Emit the file the tool produced, unedited.
- **log** (\`.txt\`, \`.log\`) — command output proving a run happened: test
  runs, migrations, gate output. Pipe to a file and emit that file.

Anything else uploads as plain \`file\` — it is never guessed into a stronger
kind, so a \`.mov\` will NOT count where a video is required; convert first.

## Captions

One sentence, present tense, saying what the exhibit shows and what that
proves: "Signup blocked for a disallowed domain — the 403 page renders."
Never put secrets, tokens, or personal data in the caption — or the pixels.

## Binding with --for

When a criterion is the reason you captured, bind it:

    outerlayer emit artifact shot.png --caption "…" --for AC-084-11

The id comes from the acceptance spec (\`acceptance/*.md\`). A criterion that
declares a required form (\`(proof: video)\`) is satisfied only by that kind —
a screenshot bound to a video criterion renders as "video required ·
screenshot attached" and does not count. Match the declared form.

## The noise rule

Satisfy the declared proofs; don't document everything. One exhibit per
criterion is the norm. An unrequested artifact is worth emitting only when
it would change how a reviewer reads the diff. When in doubt, leave it out —
evidence works because there is little of it.

## Mechanics

Inside a recorded session, just run the command — the artifact spools
locally and uploads with the next \`outerlayer sync\`, bound to this session
and turn. In CI, run it after the step that produced the file (repo and PR
come from the CI environment). From a plain machine it anchors through the
git checkout, or pass \`--pr <n>\` explicitly. If there is nothing to attach
to, the command refuses — emit from the work, not from nowhere.
`;

const AGENTS_SNIPPET_CONTENT = `${AGENTS_MD_MARKER}
## Emitting evidence

When you finish work a spec criterion covers — especially one declaring a
required proof form ("proof: video") — capture the working state and emit it:

    outerlayer emit artifact <file> --caption "what it shows" [--for <criterion-id>] [--pr <n>]

Rules: capture AFTER the state exists (run it, then shoot it); kind comes
from the file type (png/jpg screenshot, webm/mp4 video, html/pdf report,
txt/log log — anything else is a plain file and satisfies nothing
stronger); every artifact caps at 8 MiB, and video is the kind most likely
to hit it; captions are one present-tense sentence with no secrets; bind
\`--for\` the criterion id from the acceptance spec, matching its declared
form exactly; satisfy declared proofs and stop — don't document everything.
Inside a recorded session the artifact uploads on the next \`outerlayer
sync\`; in CI it anchors via the CI environment; otherwise the git checkout
or \`--pr\` anchors it, and with nothing to attach to the command refuses.
`;

function writeOutFile(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function runImportCapture(opts: ImportCaptureCommandOptions = {}): ImportCaptureCommandResult {
  const cwd = opts.cwd ?? process.cwd();
  let cwdStat;
  try {
    cwdStat = statSync(cwd);
  } catch {
    throw new ImportCaptureError(`no such directory: ${cwd}`);
  }
  if (!cwdStat.isDirectory()) throw new ImportCaptureError(`not a directory: ${cwd}`);

  // Hard refusal BEFORE any write: never overwrite a hand-tuned skill —
  // remove it first to reinstall. A byte-identical skill is our own earlier
  // install (a partial one dies between writes), so the run resumes instead
  // of wedging.
  const skillAbs = join(cwd, SKILL_PATH);
  if (existsSync(skillAbs) && readFileSync(skillAbs, "utf8") !== SKILL_CONTENT) {
    throw new ImportCaptureError(
      `refusing to import — ${SKILL_PATH} already exists with local edits (never overwritten; remove it first to reinstall)`,
    );
  }

  const files: string[] = [];
  for (const [relPath, content] of [
    [SKILL_PATH, SKILL_CONTENT],
    [SNIPPET_PATH, AGENTS_SNIPPET_CONTENT],
  ] as const) {
    if (existsSync(join(cwd, relPath))) continue;
    writeOutFile(cwd, relPath, content);
    files.push(relPath);
  }

  let appendedAgentsMd = false;
  const agentsMdAbs = join(cwd, AGENTS_MD_PATH);
  if (existsSync(agentsMdAbs)) {
    const existing = readFileSync(agentsMdAbs, "utf8");
    if (!existing.includes(AGENTS_MD_MARKER)) {
      writeFileSync(agentsMdAbs, existing + "\n" + AGENTS_SNIPPET_CONTENT);
      appendedAgentsMd = true;
    }
  }

  let output: string;
  if (opts.json) {
    output = JSON.stringify({ files, appendedAgentsMd });
  } else {
    const lines = files.map((f) => `${GREEN}✓${RESET} wrote ${f}`);
    if (appendedAgentsMd) lines.push(`${GREEN}✓${RESET} appended the evidence snippet to ${AGENTS_MD_PATH}`);
    if (files.length === 0 && !appendedAgentsMd) {
      lines.push(`${DIM}capture pack already installed — nothing to write${RESET}`);
    }
    lines.push(`Run ${YELLOW}\`outerlayer emit\`${RESET} to compile the pack into your agent's native files.`);
    output = lines.join("\n");
  }
  if (!opts.quiet) {
    process.stdout.write(output + "\n");
    if (!opts.json && !appendedAgentsMd && !existsSync(agentsMdAbs)) {
      process.stdout.write(
        `${DIM}  no ${AGENTS_MD_PATH} to append to — paste ${SNIPPET_PATH} into your instructions file if your harness reads no skills${RESET}\n`,
      );
    }
  }

  return { files, appendedAgentsMd, output };
}
