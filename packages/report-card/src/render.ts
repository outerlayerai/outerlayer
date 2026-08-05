// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Card renderings — terminal + self-contained HTML — both gated by the
 * integrity lint (integrity.ts) on their OWN output. The HTML export IS the
 * design-partner deliverable and the launch content; it must stand alone
 * (inline styles, no external assets, no scripts). CLI and dashboard share
 * this renderer — one source of truth.
 */

import { verdictLabel, type ReportCard, type Verdict } from "./card.js";
import { assertCardIntegrity } from "./integrity.js";

const VERDICT_COLOR: Record<Verdict, string> = {
  clear: "#2ea043",
  directional: "#d29922",
  underpowered: "#8250df",
};

function pctCi(rate: number, ci: [number, number]): string {
  return `${(rate * 100).toFixed(0)}% [${(ci[0] * 100).toFixed(0)}–${(ci[1] * 100).toFixed(0)}]`;
}

function signedPp(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}pp`;
}

export function renderCardText(card: ReportCard): string {
  const s = card.stats;
  const [aId, bId] = s.configs;
  const lines: string[] = [];
  lines.push(`Harness Report Card — ${card.repoLabel}`);
  lines.push(`[${verdictLabel(card.verdict)}]  ${card.conclusion}`);
  lines.push("");
  lines.push(`Primary — paired Δ resolve rate: ${signedPp(s.pairedDelta.est)} (95% CI ${signedPp(s.pairedDelta.ci95[0])}..${signedPp(s.pairedDelta.ci95[1])})`);
  lines.push(`  ${aId}: ${pctCi(s.resolveRate.a.rate, s.resolveRate.a.ci95)}   ${bId}: ${pctCi(s.resolveRate.b.rate, s.resolveRate.b.ci95)}`);
  lines.push(`  ${card.mdeLine}`);
  lines.push("");
  lines.push(`Economics — $/resolved-task: ${aId} $${s.dollarsPerResolved.a.toFixed(2)} · ${bId} $${s.dollarsPerResolved.b.toFixed(2)} · total run $${s.totalCostUsd.toFixed(2)}`);
  lines.push("");
  lines.push("Where it breaks");
  for (const tax of card.taxonomy) {
    const parts = Object.entries(tax.counts).filter(([, c]) => c > 0).map(([k, c]) => `${k}=${c}`);
    lines.push(`  ${tax.configId}: ${parts.join(" ") || "—"}`);
  }
  if (card.divergent.length > 0) {
    lines.push(`  divergent tasks: ${card.divergent.map((d) => d.taskId).join(", ")}`);
  }
  lines.push("");
  lines.push("Disclosures");
  lines.push(`  ${s.nTasks} tasks × ${s.trialsPerTask} trials · verdict rule: ${s.verdictRules}`);
  if (card.requestedTasks != null && card.requestedTasks > s.nTasks) {
    lines.push(`  requested ${card.requestedTasks} tasks; ran ${s.nTasks} (capped to the available task set)`);
  }
  if (s.exclusions.length > 0) {
    lines.push(`  exclusions: ${s.exclusions.map((e) => `${e.taskId} (${e.reason})`).join(", ")}`);
    lines.push(`  sensitivity: excluding them ${s.sensitivity.excludedFlippedConclusion ? "FLIPS" : "does not change"} the conclusion`);
  }
  if (card.quarantinedTests.length > 0) lines.push(`  quarantined tests: ${card.quarantinedTests.join(", ")}`);

  const text = lines.join("\n");
  assertCardIntegrity(card, text);
  return text;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderCardHtml(card: ReportCard): string {
  const s = card.stats;
  const [aId, bId] = s.configs;
  const taxRows = card.taxonomy
    .map((tax) => {
      const parts = Object.entries(tax.counts).filter(([, c]) => c > 0).map(([k, c]) => `${esc(k)} ${c}`).join(", ");
      return `<tr><td>${esc(tax.configId)}</td><td>${parts || "—"}</td></tr>`;
    })
    .join("");
  const taskRows = card.perTask
    .map(
      (row) =>
        `<tr><td>${esc(row.taskId)}</td><td>${row.aResolved}/${row.trials}</td><td>${row.bResolved}/${row.trials}</td><td>$${row.aCostUsd.toFixed(2)}</td><td>$${row.bCostUsd.toFixed(2)}</td></tr>`,
    )
    .join("");
  const exclusions = s.exclusions.length
    ? `<p class="muted">Exclusions: ${s.exclusions.map((e) => `${esc(e.taskId)} (${esc(e.reason)})`).join(", ")}. Sensitivity: excluding them ${s.sensitivity.excludedFlippedConclusion ? "<strong>flips</strong>" : "does not change"} the conclusion.</p>`
    : "";
  const methodology = card.methodologyUrl
    ? `<a href="${esc(card.methodologyUrl)}">methodology</a> · `
    : "";
  const clampNote =
    card.requestedTasks != null && card.requestedTasks > s.nTasks
      ? `<p class="muted">Requested ${card.requestedTasks} tasks; ran ${s.nTasks} (capped to the available task set).</p>`
      : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Report Card — ${esc(card.repoLabel)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width: 720px; margin: 32px auto; padding: 0 20px; color: #1f2328; background:#fff; }
  h1 { font-size: 19px; margin: 0 0 12px; }
  .chip { display:inline-block; padding:5px 13px; border-radius:999px; color:#fff; font-weight:600; font-size:13px; }
  .conclusion { font-size:17px; margin:12px 0 4px; font-weight:500; }
  .mde { background:#fff8c5; border:1px solid #d4a72c66; border-radius:6px; padding:8px 12px; font-size:14px; margin:14px 0; }
  section { border:1px solid #d0d7de; border-radius:8px; padding:14px 18px; margin:14px 0; }
  section h2 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#656d76; margin:0 0 10px; }
  .primary { display:flex; gap:24px; flex-wrap:wrap; align-items:baseline; }
  .delta { font-size:28px; font-weight:700; font-variant-numeric:tabular-nums; }
  .rate { font-size:14px; color:#656d76; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th,td { text-align:left; padding:4px 8px 4px 0; }
  th { color:#656d76; font-weight:600; border-bottom:1px solid #d0d7de; }
  td:not(:first-child) { font-variant-numeric:tabular-nums; }
  .muted { color:#656d76; font-size:12px; }
  footer { color:#8c959f; font-size:12px; margin-top:20px; }
</style></head>
<body>
  <h1>Harness Report Card <span class="muted">· ${esc(card.repoLabel)}</span></h1>
  <span class="chip" style="background:${VERDICT_COLOR[card.verdict]}">${verdictLabel(card.verdict)}</span>
  <p class="conclusion">${esc(card.conclusion)}</p>
  <div class="mde">${esc(card.mdeLine)}</div>

  <section>
    <h2>Primary — paired Δ resolve rate</h2>
    <div class="primary">
      <span class="delta" style="color:${VERDICT_COLOR[card.verdict]}">${signedPp(s.pairedDelta.est)}</span>
      <span class="rate">95% CI ${signedPp(s.pairedDelta.ci95[0])} .. ${signedPp(s.pairedDelta.ci95[1])}</span>
    </div>
    <p class="rate">${esc(aId)}: ${pctCi(s.resolveRate.a.rate, s.resolveRate.a.ci95)} &nbsp;·&nbsp; ${esc(bId)}: ${pctCi(s.resolveRate.b.rate, s.resolveRate.b.ci95)} &nbsp;(Wilson 95%)</p>
  </section>

  <section>
    <h2>Economics — $ / resolved task</h2>
    <p class="primary"><span>${esc(aId)}: <strong>$${s.dollarsPerResolved.a.toFixed(2)}</strong></span><span>${esc(bId)}: <strong>$${s.dollarsPerResolved.b.toFixed(2)}</strong></span><span class="rate">total run $${s.totalCostUsd.toFixed(2)}</span></p>
  </section>

  <section>
    <h2>Where it breaks</h2>
    <table><tr><th>Config</th><th>Failure taxonomy</th></tr>${taxRows}</table>
    ${card.divergent.length ? `<p class="muted">Divergent tasks (resolved by one, not the other): ${card.divergent.map((d) => esc(d.taskId)).join(", ")}</p>` : ""}
  </section>

  ${taskRows ? `<section><h2>Per-task</h2><table><tr><th>Task</th><th>${esc(aId)}</th><th>${esc(bId)}</th><th>$${esc(aId)}</th><th>$${esc(bId)}</th></tr>${taskRows}</table></section>` : ""}

  <section>
    <h2>Disclosures</h2>
    <p class="muted">${s.nTasks} tasks × ${s.trialsPerTask} trials. Verdict rule: ${esc(s.verdictRules)}</p>
    ${clampNote}
    ${exclusions}
    ${card.quarantinedTests.length ? `<p class="muted">Quarantined (flaky, excluded): ${card.quarantinedTests.map(esc).join(", ")}</p>` : ""}
    <p class="muted">${methodology}schema v${card.schemaVersion}</p>
  </section>

  <footer>Generated by OuterLayer · one primary metric (paired resolve-rate Δ); everything else is secondary/exploratory.</footer>
</body></html>`;
  assertCardIntegrity(card, html);
  return html;
}
