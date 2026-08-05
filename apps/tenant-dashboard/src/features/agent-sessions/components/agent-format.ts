/** Shared formatting for the Agents sections. */

export const money = (n: number | null | undefined): string =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const compactNum = (n: number | null | undefined): string => {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
};

export const pct = (r: number | null | undefined): string => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);

/** Signed delta between current and prior as a percent, plus a direction. */
export function deltaOf(current: number, prior: number): { text: string; dir: "up" | "down" | "flat" } {
  if (!prior) return { text: current ? "new" : "—", dir: current ? "up" : "flat" };
  const d = (current - prior) / prior;
  if (Math.abs(d) < 0.005) return { text: "±0%", dir: "flat" };
  return { text: `${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}%`, dir: d > 0 ? "up" : "down" };
}

export const shortModel = (m: string): string => m.replace(/^.*\//, "");

export const fmtMs = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

export const shortProject = (p: string | null | undefined): string => {
  if (!p) return "(no project)";
  return p.includes("/") ? p.split("/").filter(Boolean).slice(-2).join("/") : p;
};

const AGENT_COLORS: Record<string, string> = {
  "claude-code": "#2065D1",
  codex: "#1E7F4F",
  cursor: "#7A5EA8",
};

/** Muted-but-distinct fallbacks for agent types the palette hasn't met. */
const FALLBACK_COLORS = ["#B54708", "#0E7490", "#9F1239", "#4D7C0F", "#6D28D9", "#A16207"] as const;

/**
 * Agent type → color, TOTAL over unknown types: the supported-agent set is
 * open (one capture adapter per agent), so anything the fixed palette doesn't
 * know gets a deterministic hash-picked fallback — two unknown agents render
 * distinctly, and the same agent renders the same color everywhere.
 */
export const agentColor = (t: string): string => {
  const known = AGENT_COLORS[t];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length]!;
};

export const SEVERITY_COLOR: Record<string, string> = { high: "#B42318", warn: "#B54708", info: "#5B6169" };
