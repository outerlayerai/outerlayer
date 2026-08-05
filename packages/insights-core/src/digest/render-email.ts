// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { DeltaStat, DigestFinding, DigestModel } from "./types.js";

// Brand: warm paper background, ink text, brand blue accents, hairline rules.
const PAPER = "#FAF8F3";
const INK = "#1B1D1F";
const BLUE = "#2065D1";
const HAIRLINE = "#E4E0D6";
const CARD = "#FFFFFF";
const MUTED = "#75716A";
const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

/** Escape a string for interpolation into HTML text or attribute values. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-29" → "Jun 29, 2026" — string surgery only, no Date/timezones. */
function fmtIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;
const fmtRate = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** The tile's delta line: "▲ 30% WoW", "baseline week" on week one, "—"
 * when a % change isn't honestly computable (prior was 0). */
function fmtDelta(stat: DeltaStat): string {
  if (stat.prior === null) return "baseline week";
  if (stat.deltaPct === null) return "—";
  if (stat.deltaPct === 0) return "±0% WoW";
  const arrow = stat.deltaPct > 0 ? "▲" : "▼";
  return `${arrow} ${Math.abs(stat.deltaPct)}% WoW`;
}

/** One stat tile — a white card whose whole face links into the dashboard. */
function tile(label: string, value: string, stat: DeltaStat, href: string): string {
  return `<a href="${esc(href)}" style="text-decoration:none;color:${INK};display:block;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${HAIRLINE};border-radius:6px;">
<tr><td style="padding:14px 16px;font-family:${FONT};">
<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${MUTED};">${esc(label)}</div>
<div style="font-size:24px;font-weight:bold;color:${INK};padding:3px 0 2px 0;">${esc(value)}</div>
<div style="font-size:12px;color:${MUTED};">${esc(fmtDelta(stat))}</div>
</td></tr>
</table>
</a>`;
}

/** One finding row: severity, the one-sentence summary, then the numbers. */
function findingRow(f: DigestFinding, href: string, first: boolean): string {
  const meta = [
    f.costUsd !== null ? fmtUsd(f.costUsd) : "no $ attributed",
    `${f.sessionCount} session${f.sessionCount === 1 ? "" : "s"}`,
  ];
  if (f.wowDelta !== null) {
    meta.push(f.wowDelta === 0 ? "±$0.00 WoW" : `${f.wowDelta > 0 ? "▲" : "▼"} ${fmtUsd(Math.abs(f.wowDelta))} WoW`);
  }
  const border = first ? "" : `border-top:1px solid ${HAIRLINE};`;
  return `<tr><td style="padding:12px 16px;font-family:${FONT};${border}">
<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${BLUE};padding:0 0 2px 0;">${esc(f.severity)}</div>
<div style="font-size:14px;line-height:20px;color:${INK};">${esc(f.summary)}</div>
<div style="font-size:12px;color:${MUTED};padding:4px 0 0 0;">${esc(meta.join(" · "))} · <a href="${esc(href)}" style="color:${BLUE};text-decoration:none;">View →</a></div>
</td></tr>`;
}

/**
 * Render the digest as a single self-contained HTML email: table layout,
 * inline CSS only, no external assets — the shape Gmail actually renders.
 * Every interpolated string goes through `esc()`; the model stays raw.
 */
export function renderDigestEmail(model: DigestModel): string {
  const overviewUrl = `${model.deepLinkBase}/agents/overview`;
  const findingsUrl = `${model.deepLinkBase}/agents/findings`;
  const isBaseline = model.tiles.sessions.prior === null;
  const period = `${fmtIsoDate(model.periodStart)} – ${fmtIsoDate(model.periodEnd)}`;

  const watchThis =
    model.watchThis === null
      ? ""
      : `<tr><td style="padding:0 0 16px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${HAIRLINE};border-left:4px solid ${BLUE};border-radius:6px;">
<tr><td style="padding:12px 16px;font-family:${FONT};">
<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${BLUE};font-weight:bold;padding:0 0 2px 0;">Watch this</div>
<div style="font-size:14px;line-height:20px;color:${INK};">${esc(model.watchThis)}</div>
</td></tr>
</table>
</td></tr>`;

  const tiles = model.tiles;
  const tileGrid = `<tr><td style="padding:0 0 16px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="50%" valign="top" style="padding:0 6px 12px 0;">${tile("Sessions", String(tiles.sessions.current), tiles.sessions, overviewUrl)}</td>
<td width="50%" valign="top" style="padding:0 0 12px 6px;">${tile("Spend", fmtUsd(tiles.costUsd.current), tiles.costUsd, overviewUrl)}</td>
</tr>
<tr>
<td width="50%" valign="top" style="padding:0 6px 0 0;">${tile("Tool error rate", fmtRate(tiles.toolErrorRate.current), tiles.toolErrorRate, overviewUrl)}</td>
<td width="50%" valign="top" style="padding:0 0 0 6px;">${tile("Active developers", String(tiles.activeActors.current), tiles.activeActors, overviewUrl)}</td>
</tr>
</table>
</td></tr>`;

  const findings =
    model.topFindings.length === 0
      ? `<tr><td style="padding:12px 16px;font-family:${FONT};font-size:14px;color:${MUTED};">No findings this week — a clean run.</td></tr>`
      : model.topFindings.map((f, i) => findingRow(f, findingsUrl, i === 0)).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.tenantName)} — weekly digest</title>
</head>
<body style="margin:0;padding:0;background-color:${PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAPER};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
<tr><td style="padding:0 0 20px 0;font-family:${FONT};">
<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BLUE};font-weight:bold;">OuterLayer · Weekly digest</div>
<div style="font-size:22px;font-weight:bold;color:${INK};padding:4px 0 2px 0;">${esc(model.tenantName)}</div>
<div style="font-size:13px;color:${MUTED};">${esc(period)}${isBaseline ? " · baseline week — deltas start next week" : ""}</div>
</td></tr>
${watchThis}${tileGrid}<tr><td style="padding:0 0 8px 0;font-family:${FONT};font-size:14px;font-weight:bold;color:${INK};">Top findings</td></tr>
<tr><td style="padding:0 0 16px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${HAIRLINE};border-radius:6px;">
${findings}
</table>
</td></tr>
<tr><td style="border-top:1px solid ${HAIRLINE};padding:16px 0 0 0;font-family:${FONT};font-size:12px;color:${MUTED};">
Sent by OuterLayer · <a href="${esc(overviewUrl)}" style="color:${BLUE};text-decoration:none;">Open dashboard</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
