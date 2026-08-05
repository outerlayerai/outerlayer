// Shared eval-run logic. One `runReport(body)` used by BOTH
// the local HTTP dev server (eval-run-server.mjs) and the production Fly worker
// (eval-worker.mjs). Provider is chosen by env: OUTERLAYER_E2B_ENABLED=1 +
// E2B_API_KEY → managed E2B microVMs (real snapshots, offline grading); else
// local Docker. Same seam, config flip.
//
// Tasks are SCRIPTED fixtures today (zero API credits, proves the loop + card
// end to end). Swapping in real mined tasks + real agent launchers (using the
// per-config secrets the worker resolves from Vault) is the orthogonal next step
// — it doesn't touch the dispatch/worker plumbing.
import { LocalDockerProvider } from "@outerlayer/runner-core";
import { e2bProviderFromEnv } from "@outerlayer/provider-e2b";
import { EnvPrepService } from "@outerlayer/env-prep";
import { REPO_DIR } from "@outerlayer/task-format";
import { runEvaluation } from "./dist/index.js";

const FUNCS = [
  { name: "divide", body: "def divide(a, b):\n    return a / b\n", call: "divide(1, 0)" },
  { name: "head", body: "def head(items):\n    return items[0]\n", call: "head([])" },
  { name: "percent", body: "def percent(part, whole):\n    return part / whole * 100.0\n", call: "percent(1, 0)" },
  { name: "last", body: "def last(items):\n    return items[-1]\n", call: "last([])" },
  { name: "average", body: "def average(nums):\n    return sum(nums) / len(nums)\n", call: "average([])" },
];
const BUGGY = FUNCS.map((f) => f.body).join("\n");
const CORRECT = [
  "def divide(a, b):\n    if b == 0:\n        return None\n    return a / b\n",
  "def head(items):\n    if not items:\n        return None\n    return items[0]\n",
  "def percent(part, whole):\n    if whole == 0:\n        return None\n    return part / whole * 100.0\n",
  "def last(items):\n    if not items:\n        return None\n    return items[-1]\n",
  "def average(nums):\n    if not nums:\n        return None\n    return sum(nums) / len(nums)\n",
].join("\n");
const PARTIAL = [
  "def divide(a, b):\n    if b == 0:\n        return None\n    return a / b\n",
  "def head(items):\n    if not items:\n        return None\n    return items[0]\n",
  "def percent(part, whole):\n    return part / whole * 100.0\n",
  "def last(items):\n    return items[-1]\n",
  "def average(nums):\n    return sum(nums) / len(nums)\n",
].join("\n");

function taskFor(f, image) {
  const testFile = `tests/test_${f.name}.py`;
  return {
    schema_version: 1, id: `fix-${f.name}`, repo: "fixture://calc", base_commit: "v1",
    problem_statement: `${f.name}() raises on an empty/zero edge case; it should return None.`,
    test_patch: `--- /dev/null\n+++ b/${testFile}\n@@ -0,0 +1,4 @@\n+from calc import ${f.name}\n+\n+def test_${f.name}_edge():\n+    assert ${f.call} is None\n`,
    gold_patch: `--- a/calc.py\n+++ b/calc.py\n@@ -1,1 +1,2 @@\n def ${f.name}(a, b):\n+    pass\n`,
    fail_to_pass: [`${testFile}::test_${f.name}_edge`], pass_to_pass: [],
    environment: { base_image: image, setup: "", test_cmd: "python -m pytest -q", runner: "pytest", timeout_s: 120 },
    quarantined: [],
  };
}
function scripted(id, content) {
  const b64 = Buffer.from(content).toString("base64");
  return {
    id,
    invoke: () => ({ command: `mkdir -p /tmp/outerlayer && echo ${b64} | base64 -d > calc.py && echo '{}' > /tmp/outerlayer/t.jsonl`, env: {}, transcriptPath: "/tmp/outerlayer/t.jsonl" }),
    parseTranscript: () => ({ launcher: id, turns: 1, toolCalls: 1, toolErrors: 0, inputTokens: content.length * 3, outputTokens: 120, cacheReadTokens: null, wallClockMs: 0 }),
  };
}
async function materialize(sandbox, provider) {
  await provider.putFiles(sandbox, { [`${REPO_DIR}/calc.py`]: BUGGY });
  const r = await provider.exec(sandbox, `cd ${REPO_DIR} && git init -q && git add -A && git -c user.email=e@o.dev -c user.name=o commit -qm base`, { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`fixture init failed: ${r.stderr}`);
}

/** Run one Report Card and return { card, spentUsd, trials }.
 * `opts.escalationSink`: where exhausted env-repair ladders
 * report — the worker passes the persisting sink; default is env-prep's
 * console sink.
 * `opts.onTranscript`: raw-transcript observer forwarded to the
 * trial harness — the worker collects these to emit AgentSessions. */
export async function runReport(body, opts = {}) {
  const provider = e2bProviderFromEnv() ?? new LocalDockerProvider();
  console.log(`[eval-run] provider: ${provider.id}`);
  const envService = new EnvPrepService({
    provider,
    materializeRepo: materialize,
    ...(opts.escalationSink ? { escalationSink: opts.escalationSink } : {}),
  });
  // E2BProvider.boot() always prefers spec.baseImage (= environment.base_image)
  // over its configured `template` (env-prep/prepare.ts passes materializeRepo,
  // so the build path always runs with a base image, never the no-build
  // fallback). A Docker-tag-style image ("outerlayer-agent:py312") is not a
  // valid E2B template name, so it must match OUTERLAYER_E2B_TEMPLATE (the
  // template actually staged on the Fly app secret) when E2B is the provider;
  // the Docker-tag form is only meaningful for LocalDockerProvider.
  const image =
    provider.id === "e2b"
      ? process.env.OUTERLAYER_E2B_TEMPLATE || "outerlayer-agent"
      : (process.env.EVAL_IMAGE ?? "outerlayer-agent:py312");
  // Tasks are scripted fixtures today, so a request for more than we have is
  // clamped to what's available. `requestedTasks` echoes the original ask onto
  // the card so the clamp is disclosed, never silent. When real
  // mined tasks land this becomes a hard error at dispatch instead.
  const requestedTasks = Math.max(1, Number(body?.taskCount ?? 5));
  const n = Math.min(FUNCS.length, requestedTasks);
  const tasks = FUNCS.slice(0, n).map((f) => taskFor(f, image));
  const budgets = { maxTurns: 3, maxTokens: 100000, wallClockS: 120 };
  const aId = body?.configs?.[0]?.id || "opus-sim";
  const bId = body?.configs?.[1]?.id || "glm-sim";
  const correct = scripted(`${aId}-agent`, CORRECT);
  const partial = scripted(`${bId}-agent`, PARTIAL);
  try {
    return await runEvaluation(
      tasks,
      [{ id: aId, launcher: `${aId}-agent`, model: aId, budgets }, { id: bId, launcher: `${bId}-agent`, model: bId, budgets }],
      {
        provider, envFactory: envService.prepareEnv, resolveSecrets: async () => ({}),
        launcher: (id) => (id === `${aId}-agent` ? correct : partial),
        prices: { [aId]: { inputPerMTok: 15, outputPerMTok: 75 }, [bId]: { inputPerMTok: 0.5, outputPerMTok: 1.5 } },
        repoLabel: body?.repoLabel || "acme/calc", trialsPerTask: Number(body?.trialsPerTask ?? 3), seed: 7, concurrency: 4,
        requestedTasks,
        methodologyUrl: "https://outerlayer.ai/docs/methodology",
        ...(opts.onTranscript ? { onTranscript: opts.onTranscript } : {}),
      },
    );
  } finally {
    // Managed provider: retire env snapshots so they don't accrue storage cost.
    await provider.dispose?.();
  }
}
