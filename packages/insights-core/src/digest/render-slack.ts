// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { DeltaStat, DigestFinding, DigestModel } from "./types.js";

/** Escape Slack's mrkdwn control chars (&, <, >). plain_text fields must NOT
 * be escaped — Slack renders entities there literally. */
function escMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;
const fmtRate = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** Same delta narration as the email so both channels tell one story. */
function fmtDelta(stat: DeltaStat): string {
  if (stat.prior === null) return "baseline week";
  if (stat.deltaPct === null) return "—";
  if (stat.deltaPct === 0) return "±0% WoW";
  const arrow = stat.deltaPct > 0 ? "▲" : "▼";
  return `${arrow} ${Math.abs(stat.deltaPct)}% WoW`;
}

/** One tile as an mrkdwn field: bold linked label, then value · delta. */
function tileField(label: string, value: string, stat: DeltaStat, url: string): object {
  return {
    type: "mrkdwn",
    text: `*<${escMrkdwn(url)}|${escMrkdwn(label)}>*\n${escMrkdwn(`${value} · ${fmtDelta(stat)}`)}`,
  };
}

/** One finding as its own section, deep-linked into the findings page. */
function findingSection(f: DigestFinding, url: string): object {
  const meta = [
    f.costUsd !== null ? fmtUsd(f.costUsd) : "no $ attributed",
    `${f.sessionCount} session${f.sessionCount === 1 ? "" : "s"}`,
  ];
  if (f.wowDelta !== null) {
    meta.push(f.wowDelta === 0 ? "±$0.00 WoW" : `${f.wowDelta > 0 ? "▲" : "▼"} ${fmtUsd(Math.abs(f.wowDelta))} WoW`);
  }
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${escMrkdwn(f.severity.toUpperCase())}* · ${escMrkdwn(f.summary)}\n${escMrkdwn(meta.join(" · "))} · <${escMrkdwn(url)}|View details>`,
    },
  };
}

/**
 * Render the digest as Slack Block Kit blocks: header, "watch this" lead
 * (when present), a tile-fields section, then a divider and one section per
 * finding, closed by a context footer. Everything interpolated into mrkdwn
 * goes through `escMrkdwn`; header/plain_text stays raw.
 */
export function renderDigestSlack(model: DigestModel): object[] {
  const overviewUrl = `${model.deepLinkBase}/agents/overview`;
  const findingsUrl = `${model.deepLinkBase}/agents/findings`;
  const tiles = model.tiles;

  const blocks: object[] = [
    { type: "header", text: { type: "plain_text", text: `${model.tenantName} — weekly agent digest`, emoji: true } },
  ];
  if (model.watchThis !== null) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Watch this:* ${escMrkdwn(model.watchThis)}` } });
  }
  blocks.push({
    type: "section",
    fields: [
      tileField("Sessions", String(tiles.sessions.current), tiles.sessions, overviewUrl),
      tileField("Spend", fmtUsd(tiles.costUsd.current), tiles.costUsd, overviewUrl),
      tileField("Tool error rate", fmtRate(tiles.toolErrorRate.current), tiles.toolErrorRate, overviewUrl),
      tileField("Active developers", String(tiles.activeActors.current), tiles.activeActors, overviewUrl),
    ],
  });
  if (model.topFindings.length > 0) {
    blocks.push({ type: "divider" });
    for (const f of model.topFindings) blocks.push(findingSection(f, findingsUrl));
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${escMrkdwn(model.tenantName)} · ${escMrkdwn(model.periodStart)} → ${escMrkdwn(model.periodEnd)} · <${escMrkdwn(overviewUrl)}|Open dashboard>`,
      },
    ],
  });
  return blocks;
}
