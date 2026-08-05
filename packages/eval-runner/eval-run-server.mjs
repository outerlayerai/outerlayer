// Local eval-run HTTP service (dev/demo). POST /run → runReport (the REAL run
// backend over real sandboxes with real grading, scripted agents = zero API
// credits). Returns the real ReportCard the dashboard renders. Production uses
// the same runReport via an ephemeral Fly Machine worker (eval-worker.mjs); this
// is the local stand-in that proves the UI↔backend wiring end to end.
import { createServer } from "node:http";
import { runReport } from "./run-eval.mjs";

const PORT = Number(process.env.EVAL_RUNNER_PORT ?? 8899);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };

createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== "POST" || !req.url.startsWith("/run")) { res.writeHead(404, CORS); return res.end("not found"); }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      const body = raw ? JSON.parse(raw) : {};
      console.log(`[eval-run] starting run: ${body.repoLabel ?? "acme/calc"} (${body.taskCount ?? 5} tasks)`);
      const result = await runReport(body);
      console.log(`[eval-run] done: verdict=${result.card.verdict} A=${(result.card.stats.resolveRate.a.rate * 100) | 0}% B=${(result.card.stats.resolveRate.b.rate * 100) | 0}%`);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ card: result.card, spentUsd: result.spentUsd, trials: result.trials.map((t) => ({ taskId: t.taskId, configId: t.configId, status: t.status, resolved: t.resolved })) }));
    } catch (err) {
      console.error("[eval-run] error:", err);
      res.writeHead(500, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
}).listen(PORT, () => console.log(`eval-run service on http://localhost:${PORT} (POST /run)`));
