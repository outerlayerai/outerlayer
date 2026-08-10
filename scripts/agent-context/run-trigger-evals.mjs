#!/usr/bin/env node
/**
 * Trigger evals for the repo's agent skills: does the right skill fire on
 * the right request, and stay quiet on near-misses?
 *
 * The skill router sees ONLY each skill's frontmatter `description`, so
 * description quality is measurable: every skill ships a labeled query set
 * (`.claude/skills/<name>/evals/trigger-queries.json` — should-trigger
 * positives plus near-miss negatives). This runner replays each query
 * against a headless `claude -p` session at the repo root and records which
 * skill (if any) actually fired, over N runs — model routing is
 * nondeterministic, so a single run proves nothing.
 *
 * Pass/fail per query: trigger rate (fraction of runs where the EXPECTED
 * skill fired) must be ≥ 0.5 for positives and < 0.5 for negatives. A
 * DIFFERENT skill firing on a negative is reported as a misfire — with
 * several skills sharing a domain (tests, CI gates, local stack), wrong-
 * skill selection is the failure class single-skill evals can't see.
 *
 * Usage:
 *   yarn evals:trigger                    # all skills, 3 runs per query
 *   yarn evals:trigger --skill=local-stack --runs=1
 *   yarn evals:trigger --limit=4          # first N queries per skill (smoke)
 *   yarn evals:trigger --dry              # list queries without running
 *
 * Cost: each query×run is one short LLM session (capped at --max-turns 2).
 * This is a manual/periodic tool, NOT a CI gate. Re-run after editing any
 * skill description and after model updates — if negatives start passing
 * with the skill's help withdrawn, the model may have absorbed the skill
 * (retirement signal).
 *
 * Requires the `claude` CLI on PATH (override with CLAUDE_BIN).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SKILLS_DIR = join(ROOT, ".claude", "skills");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const THRESHOLD = 0.5;
const RUN_TIMEOUT_MS = 180_000;
const CONCURRENCY = 4;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const RUNS = Number(args.get("runs") ?? 3);
const ONLY_SKILL = args.get("skill");
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;
const GREP = args.get("grep");
const DRY = args.has("dry");

function loadQuerySets() {
  const sets = [];
  for (const name of readdirSync(SKILLS_DIR)) {
    if (ONLY_SKILL && name !== ONLY_SKILL) continue;
    const file = join(SKILLS_DIR, name, "evals", "trigger-queries.json");
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    let queries = parsed.queries;
    if (typeof GREP === "string") queries = queries.filter((q) => q.query.includes(GREP));
    queries = queries.slice(0, LIMIT);
    if (queries.length > 0) sets.push({ skill: name, queries });
  }
  return sets;
}

/** Runs one headless session; resolves to the set of skill names invoked.
 * stream-json is parsed line-wise; a `tool_use` block for the Skill tool
 * carries the chosen skill in its input. The session is killed as soon as a
 * skill fires — the routing decision is what we measure, not the answer. */
function probeQuery(query) {
  return new Promise((resolve) => {
    const fired = new Set();
    const child = spawn(
      CLAUDE_BIN,
      [
        "-p", query,
        "--output-format", "stream-json",
        "--verbose",
        "--max-turns", "2",
        "--allowedTools", "Skill",
        "--strict-mcp-config",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    let buf = "";
    const scan = (obj) => {
      if (obj && typeof obj === "object") {
        if (obj.type === "tool_use" && /^skill$/i.test(obj.name ?? "")) {
          const skill = obj.input?.skill ?? obj.input?.command;
          if (typeof skill === "string") {
            fired.add(skill.trim());
            child.kill("SIGTERM");
          }
        }
        for (const v of Object.values(obj)) scan(v);
      }
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try { scan(JSON.parse(line)); } catch { /* non-JSON noise */ }
      }
    });
    child.on("close", () => { clearTimeout(timer); resolve(fired); });
    child.on("error", () => { clearTimeout(timer); resolve(fired); });
  });
}

async function pooled(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx]);
      }
    }),
  );
  return results;
}

const sets = loadQuerySets();
if (sets.length === 0) {
  console.error(`no trigger-queries.json found under ${SKILLS_DIR}` + (ONLY_SKILL ? ` for skill '${ONLY_SKILL}'` : ""));
  process.exit(1);
}

if (DRY) {
  for (const { skill, queries } of sets) {
    console.log(`\n${skill} (${queries.length} queries)`);
    for (const q of queries) console.log(`  [${q.should_trigger ? "+" : "-"}] ${q.query}`);
  }
  process.exit(0);
}

const jobs = sets.flatMap(({ skill, queries }) =>
  queries.flatMap((q) => Array.from({ length: RUNS }, (_, run) => ({ skill, q, run }))),
);
console.log(`running ${jobs.length} probes (${RUNS} run(s) per query, concurrency ${CONCURRENCY})…`);
const outcomes = await pooled(jobs, async (job) => ({ ...job, fired: [...(await probeQuery(job.q.query))] }));

const report = [];
let failures = 0;
for (const { skill, queries } of sets) {
  for (const q of queries) {
    const runs = outcomes.filter((o) => o.skill === skill && o.q.query === q.query);
    const hits = runs.filter((o) => o.fired.includes(skill)).length;
    const others = [...new Set(runs.flatMap((o) => o.fired.filter((f) => f !== skill)))];
    const rate = hits / runs.length;
    const pass = q.should_trigger ? rate >= THRESHOLD : rate < THRESHOLD;
    if (!pass) failures++;
    report.push({ skill, query: q.query, should_trigger: q.should_trigger, trigger_rate: rate, other_skills_fired: others, pass });
    const tag = pass ? "ok  " : "FAIL";
    const misfire = others.length ? `  (also fired: ${others.join(", ")})` : "";
    console.log(`${tag} ${skill}  ${q.should_trigger ? "+" : "-"}  rate=${rate.toFixed(2)}  ${q.query.slice(0, 70)}${misfire}`);
  }
}

mkdirSync(join(ROOT, "reports", "agent-context"), { recursive: true });
const out = join(ROOT, "reports", "agent-context", "trigger-evals.json");
writeFileSync(out, JSON.stringify({ runs_per_query: RUNS, threshold: THRESHOLD, results: report }, null, 2));
console.log(`\n${report.length - failures}/${report.length} queries passed — report: ${out}`);
process.exit(failures > 0 ? 1 : 0);
