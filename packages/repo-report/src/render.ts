// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * RepoReport renderings: terminal + a self-contained HTML file. The HTML is
 * the OUTREACH artifact ("run one command, get your agent-readiness report")
 * — it must stand alone when forwarded to an EM who has never seen the
 * product: inline styles, no external assets, no scripts.
 */

import type { Banner, RepoReport } from "./report.js";

const BANNER_LABEL: Record<Banner, string> = {
  ready: "Ready",
  ready_with_caveats: "Ready with caveats",
  not_yet: "Not yet",
};

export function renderReportText(report: RepoReport): string {
  const lines: string[] = [];
  lines.push(`OuterLayer Repo Report — ${report.repo} @ ${report.headCommit.slice(0, 10)}`);
  lines.push("");
  lines.push(`  ${bannerGlyph(report.banner)} ${BANNER_LABEL[report.banner]} — ${report.bannerReason}`);
  lines.push(`  stack: ${report.stack.support} (${report.stack.reason})`);
  lines.push("");
  lines.push("  Mining funnel");
  lines.push(`    ${report.mining.prsScanned} PRs scanned → ${report.mining.candidates} candidates → ${report.mining.validated} validated (${(report.mining.yieldPct * 100).toFixed(1)}% yield)`);
  for (const [reason, count] of Object.entries(report.mining.rejectedByReason)) {
    if (count > 0) lines.push(`      ✗ ${reason}: ${count}`);
  }
  lines.push("");
  lines.push("  Environment");
  lines.push(`    ${report.env.deterministic} deterministic · ${report.env.repaired} repaired · ${report.env.escalated} escalated · cache hit ${(report.env.cacheHitRate * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("  Test-suite health");
  lines.push(`    ${report.validation.valid} valid · ${report.validation.needsReview} needs-review · ${report.validation.invalid} invalid`);
  if (report.validation.quarantinedTests.length > 0) {
    lines.push(`    quarantined (flaky): ${report.validation.quarantinedTests.join(", ")}`);
  }
  lines.push("");
  lines.push("  Statistical power (detectable delta at N validated tasks)");
  for (const row of report.power) {
    lines.push(`    ${report.validation.valid} tasks × ${row.trials} trial(s) ⇒ MDE ≈ ${row.mdePct.toFixed(0)}pp`);
  }
  if (report.powerNote) lines.push(`    ${report.powerNote}`);
  lines.push("");
  lines.push(`  Estimated card cost: $${report.cost.lowUsd.toFixed(0)}–$${report.cost.highUsd.toFixed(0)} (${report.cost.note})`);
  lines.push("");
  lines.push(`  → ${report.nextStep}`);
  return lines.join("\n");
}

function bannerGlyph(banner: Banner): string {
  return banner === "ready" ? "✓" : banner === "ready_with_caveats" ? "⚠" : "✗";
}

const BANNER_COLOR: Record<Banner, string> = {
  ready: "#2ea043",
  ready_with_caveats: "#d29922",
  not_yet: "#cf222e",
};

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Self-contained HTML — no external assets, safe to forward as a file. */
export function renderReportHtml(report: RepoReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const funnelRows = Object.entries(report.mining.rejectedByReason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `<tr><td>${esc(reason)}</td><td>${count}</td></tr>`)
    .join("");
  const powerRows = report.power
    .map(
      (row) =>
        `<tr><td>${report.validation.valid} × ${row.trials}</td><td>≈ ${row.mdePct.toFixed(0)}pp</td></tr>`,
    )
    .join("");
  const quarantined = report.validation.quarantinedTests.length
    ? `<p class="muted">Quarantined (flaky, excluded from grading): ${report.validation.quarantinedTests.map(esc).join(", ")}</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OuterLayer Repo Report — ${esc(report.repo)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width: 720px; margin: 32px auto; padding: 0 20px; color: #1f2328; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .commit { color: #656d76; font: 13px ui-monospace,monospace; margin-bottom: 20px; }
  .banner { display: inline-block; padding: 6px 14px; border-radius: 999px; color: #fff; font-weight: 600; font-size: 14px; }
  .reason { margin: 10px 0 24px; font-size: 15px; }
  section { border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 18px; margin: 14px 0; }
  section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #656d76; margin: 0 0 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  td { padding: 3px 0; }
  td:last-child { text-align: right; font-variant-numeric: tabular-nums; color: #656d76; }
  .funnel { font-size: 15px; margin: 0 0 8px; }
  .muted { color: #656d76; font-size: 13px; }
  .next { background: #ddf4ff; border: 1px solid #54aeff66; border-radius: 8px; padding: 14px 18px; margin-top: 18px; font-weight: 500; }
  footer { color: #8c959f; font-size: 12px; margin-top: 24px; }
</style></head>
<body>
  <h1>OuterLayer Repo Report</h1>
  <div class="commit">${esc(report.repo)} @ ${esc(report.headCommit.slice(0, 10))}</div>
  <span class="banner" style="background:${BANNER_COLOR[report.banner]}">${BANNER_LABEL[report.banner]}</span>
  <p class="reason">${esc(report.bannerReason)}<br><span class="muted">Stack: ${esc(report.stack.reason)}</span></p>

  <section>
    <h2>Mining funnel</h2>
    <p class="funnel">${report.mining.prsScanned} PRs scanned → ${report.mining.candidates} candidates → <strong>${report.mining.validated} validated</strong> (${(report.mining.yieldPct * 100).toFixed(1)}% yield)</p>
    ${funnelRows ? `<table>${funnelRows}</table>` : ""}
  </section>

  <section>
    <h2>Environment</h2>
    <table>
      <tr><td>Deterministic builds</td><td>${report.env.deterministic}</td></tr>
      <tr><td>Repaired</td><td>${report.env.repaired}</td></tr>
      <tr><td>Escalated (need setup help)</td><td>${report.env.escalated}</td></tr>
      <tr><td>Cache hit rate</td><td>${pct(report.env.cacheHitRate)}</td></tr>
    </table>
  </section>

  <section>
    <h2>Test-suite health</h2>
    <table>
      <tr><td>Valid tasks</td><td>${report.validation.valid}</td></tr>
      <tr><td>Needs review</td><td>${report.validation.needsReview}</td></tr>
      <tr><td>Invalid</td><td>${report.validation.invalid}</td></tr>
    </table>
    ${quarantined}
  </section>

  <section>
    <h2>Statistical power — detectable delta</h2>
    <table><tr><td><strong>Tasks × trials</strong></td><td><strong>MDE</strong></td></tr>${powerRows}</table>
    ${report.powerNote ? `<p class="muted">${esc(report.powerNote)}</p>` : ""}
    <p class="muted">You can detect differences at or above the MDE; smaller gaps need more tasks (more history or synthetic augmentation) or more trials.</p>
  </section>

  <section>
    <h2>Estimated card cost</h2>
    <p class="funnel">$${report.cost.lowUsd.toFixed(0)}–$${report.cost.highUsd.toFixed(0)}</p>
    <p class="muted">${esc(report.cost.note)}</p>
  </section>

  <div class="next">→ ${esc(report.nextStep)}</div>
  <footer>Generated by OuterLayer · execution-verified private evals from your own PRs · no agent runs in this report.</footer>
</body></html>`;
}
