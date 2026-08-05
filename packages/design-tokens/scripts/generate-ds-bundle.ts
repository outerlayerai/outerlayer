/**
 * Renders the design tokens into self-contained HTML preview cards for the
 * Claude Design project (claude.ai/design). Each card carries a first-line
 * `@dsCard` marker the Design System pane indexes, shows the light and dark
 * scheme side by side, and inlines all CSS — the design pane enforces a strict
 * CSP, so nothing external may be referenced.
 *
 * Output: ds-bundle/ next to this package's root (gitignored — regenerate with
 * `yarn gen:ds-bundle`, then sync via the DesignSync flow).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  BRAND_PRIMARY_DARK,
  DISPLAY_SCALE,
  BRAND_PRIMARY_LIGHT,
  cssVarsBlock,
  FONT,
  fontStack,
  NEUTRAL,
  PLATFORM_ADMIN_PRIMARY_MAIN,
  RADIUS,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  TYPE_SCALE,
  type ColorRamp,
  type TypeVariant,
  type SemanticRamp,
} from "../index";

const OUT_DIR = join(__dirname, "..", "ds-bundle");

const BASE_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: ${fontStack(FONT.sans)}; font-size: 14px; }
.schemes { display: grid; grid-template-columns: 1fr 1fr; min-height: 100vh; }
.scheme { padding: 24px; }
.scheme-light { ${cssVarsBlock("light", "")} }
.scheme-dark { ${cssVarsBlock("dark", "")} }
.scheme { background: var(--am-bg-default); color: var(--am-text-primary); }
.scheme-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--am-text-secondary); margin-bottom: 16px; }
.mono { font-family: ${fontStack(FONT.mono)}; }
`;

function page(title: string, group: string, body: string, extraCss = ""): string {
  return `<!-- @dsCard group="${group}" -->
<meta charset="utf-8">
<title>${title}</title>
<style>${BASE_CSS}${extraCss}</style>
<div class="schemes">
  <div class="scheme scheme-light"><div class="scheme-label">Light</div>${body}</div>
  <div class="scheme scheme-dark"><div class="scheme-label">Dark</div>${body}</div>
</div>
`;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const SWATCH_CSS = `
.ramp { margin-bottom: 20px; }
.ramp h3 { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.swatches { display: flex; gap: 6px; flex-wrap: wrap; }
.swatch { width: 84px; border-radius: 8px; overflow: hidden; border: 1px solid var(--am-divider); }
.swatch .chip { height: 44px; }
.swatch .meta { padding: 5px 7px; background: var(--am-bg-paper); font-size: 10px; line-height: 1.5; }
.swatch .meta b { display: block; font-weight: 600; }
`;

function rampSwatches(ramp: ColorRamp | SemanticRamp): string {
  return Object.entries(ramp)
    .filter(([step]) => step !== "contrastText")
    .map(
      ([step, value]) => `
      <div class="swatch"><div class="chip" style="background:${value}"></div>
      <div class="meta"><b>${step}</b><span class="mono">${value}</span></div></div>`,
    )
    .join("");
}

function brandCard(): string {
  const body = `
    <div class="ramp"><h3>Primary — brand blue</h3><div class="swatches" data-light>${rampSwatches(BRAND_PRIMARY_LIGHT)}</div><div class="swatches" data-dark>${rampSwatches(BRAND_PRIMARY_DARK)}</div></div>
    <div class="ramp"><h3>Platform admin accent</h3><div class="swatches">
      <div class="swatch"><div class="chip" style="background:${PLATFORM_ADMIN_PRIMARY_MAIN}"></div><div class="meta"><b>main</b><span class="mono">${PLATFORM_ADMIN_PRIMARY_MAIN}</span></div></div>
    </div></div>`;
  // The per-scheme ramp differs (dark lifts main for AA) — show each panel its own.
  const css = `${SWATCH_CSS}
.scheme-light [data-dark] { display: none; }
.scheme-dark [data-light] { display: none; }`;
  return page("Brand color", "Colors", body, css);
}

function neutralCard(): string {
  const body = `
    <div class="ramp"><h3>Warm-neutral ink ramp</h3><div class="swatches">${Object.entries(
      NEUTRAL,
    )
      .map(
        ([step, value]) => `
      <div class="swatch"><div class="chip" style="background:${value}"></div><div class="meta"><b>${step}</b><span class="mono">${value}</span></div></div>`,
      )
      .join("")}</div></div>
    <p style="font-size:12px;color:var(--am-text-secondary);max-width:60ch">A warm lightness ladder — deliberately not a cool grey family. Drives text, backgrounds, and dividers in both schemes.</p>`;
  return page("Neutrals", "Colors", body, SWATCH_CSS);
}

function semanticCard(): string {
  const sets: Array<["light" | "dark", typeof SEMANTIC_LIGHT]> = [
    ["light", SEMANTIC_LIGHT],
    ["dark", SEMANTIC_DARK],
  ];
  const body = sets
    .map(
      ([mode, set]) => `<div data-${mode}>${(Object.entries(set) as Array<[string, SemanticRamp]>)
        .map(([name, ramp]) => `<div class="ramp"><h3>${name}</h3><div class="swatches">${rampSwatches(ramp)}</div></div>`)
        .join("")}</div>`,
    )
    .join("");
  const css = `${SWATCH_CSS}
.scheme-light [data-dark] { display: none; }
.scheme-dark [data-light] { display: none; }`;
  return page("Status colors", "Colors", body, css);
}

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

function typeCard(): string {
  const rows = ([...Object.entries(DISPLAY_SCALE), ...Object.entries(TYPE_SCALE)] as Array<[string, TypeVariant]>)
    .map(([variant, style]) => {
      const decl = [
        `font-size:${style.fontSize}`,
        `font-weight:${style.fontWeight}`,
        "lineHeight" in style ? `line-height:${style.lineHeight}` : "",
        "letterSpacing" in style ? `letter-spacing:${typeof style.letterSpacing === "number" ? `${style.letterSpacing}px` : style.letterSpacing}` : "",
        "textTransform" in style ? `text-transform:${style.textTransform}` : "",
      ]
        .filter(Boolean)
        .join(";");
      return `<div class="row"><span class="tag mono">${variant} · ${style.fontSize} / ${style.fontWeight}</span><div style="${decl}">Reliable agents ship with evals</div></div>`;
    })
    .join("");
  const body = `${rows}
    <div class="row"><span class="tag mono">mono · trace ids, code</span><div class="mono" style="font-size:0.8125rem">trace_01HZY3 · gpt-4o · 1,204 tok</div></div>`;
  const css = `
.row { margin-bottom: 14px; }
.tag { display:block; font-size: 10px; color: var(--am-text-secondary); margin-bottom: 2px; }`;
  return page("Type scale", "Type", body, css);
}

// ---------------------------------------------------------------------------
// Shape + shadow
// ---------------------------------------------------------------------------

function shapeCard(): string {
  const radii = Object.entries(RADIUS)
    .map(
      ([name, px]) => `
    <div class="shape-item"><div class="shape-box" style="border-radius:${px}px"></div><span class="mono">${name} · ${px}px</span></div>`,
    )
    .join("");
  const body = `
    <h3 class="h">Radii</h3><div class="shapes">${radii}</div>
    <h3 class="h">Shadows — the only two in the system</h3>
    <div class="shadow-row">
      <div class="shadow-box" style="box-shadow:var(--am-shadow-overlay)">overlay</div>
      <div class="shadow-box" style="box-shadow:var(--am-shadow-dialog)">dialog</div>
    </div>
    <p style="font-size:12px;color:var(--am-text-secondary);max-width:56ch">Resting surfaces use 1px borders, never elevation. Only overlays (menus, popovers) and dialogs cast these shadows.</p>`;
  const css = `
.h { font-size: 13px; font-weight: 600; margin: 18px 0 10px; }
.shapes { display: flex; gap: 16px; }
.shape-item { text-align: center; font-size: 10px; color: var(--am-text-secondary); }
.shape-box { width: 72px; height: 48px; border: 1px solid var(--am-divider); background: var(--am-bg-paper); margin-bottom: 4px; }
.shadow-row { display: flex; gap: 24px; margin-bottom: 14px; }
.shadow-box { width: 120px; height: 72px; border-radius: 10px; background: var(--am-bg-paper); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--am-text-secondary); }`;
  return page("Shape & shadow", "Foundations", body, css);
}

// ---------------------------------------------------------------------------
// Components — plain-HTML renderings of the theme's component language
// ---------------------------------------------------------------------------

const BUTTON_CSS = `
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: 6px 14px; border-radius: ${RADIUS.control}px; font: inherit; font-weight: 500; border: 1px solid transparent; cursor: pointer; }
.btn-ink { background: var(--am-text-primary); color: var(--am-bg-paper); }
.btn-primary { background: var(--am-primary-main); color: var(--am-primary-contrast); }
.btn-outlined { background: transparent; border-color: var(--am-divider); color: var(--am-text-primary); }
.btn-text { background: transparent; color: var(--am-text-primary); }
.btn-danger { background: var(--am-error-main); color: #fff; }
.row { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.cap { font-size: 11px; color: var(--am-text-secondary); margin-bottom: 4px; }`;

function buttonsCard(): string {
  const body = `
    <div class="cap">A bare button is ink — brand blue is opt-in. No elevation anywhere.</div>
    <div class="row">
      <button class="btn btn-ink">New trace</button>
      <button class="btn btn-primary">Run eval</button>
      <button class="btn btn-outlined">Configure</button>
      <button class="btn btn-text">Cancel</button>
      <button class="btn btn-danger">Delete</button>
    </div>
    <div class="cap">Segmented control — tab language, selected reads as the one blue.</div>
    <div class="row">
      <span class="seg"><button class="btn btn-outlined seg-btn selected">Traces</button><button class="btn btn-outlined seg-btn">Sessions</button><button class="btn btn-outlined seg-btn">Scores</button></span>
    </div>`;
  const css = `${BUTTON_CSS}
.seg { display: inline-flex; }
.seg-btn { border-radius: 0; margin-left: -1px; }
.seg-btn:first-child { border-radius: ${RADIUS.control}px 0 0 ${RADIUS.control}px; margin-left: 0; }
.seg-btn:last-child { border-radius: 0 ${RADIUS.control}px ${RADIUS.control}px 0; }
.seg-btn.selected { color: var(--am-primary-main); background: var(--am-action-selected); }`;
  return page("Buttons", "Components", body, css);
}

function inputsCard(): string {
  const body = `
    <div class="cap">40px control height across fields and buttons. Focus is a neutral ink border — no brand-blue ring.</div>
    <div class="stack">
      <label class="field"><span class="lbl">Prompt name</span><input class="inp" value="support-triage" /></label>
      <label class="field"><span class="lbl">Focused</span><input class="inp focused" value="cursor here" /></label>
      <label class="field"><span class="lbl">Error</span><input class="inp error" value="not-a-slug!" /><span class="err">Lowercase letters and dashes only</span></label>
    </div>
    <div class="cap" style="margin-top:16px">Selection controls check as ink, not blue.</div>
    <div class="row">
      <span class="check checked"></span><span class="check"></span>
      <span class="switch on"><span class="thumb"></span></span><span class="switch"><span class="thumb"></span></span>
    </div>`;
  const css = `
.stack { display: flex; flex-direction: column; gap: 12px; max-width: 280px; }
.cap { font-size: 11px; color: var(--am-text-secondary); margin-bottom: 8px; max-width: 40ch; }
.lbl { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; color: var(--am-text-secondary); }
.inp { width: 100%; min-height: 40px; padding: 10px 12px; border-radius: ${RADIUS.control}px; border: 1px solid var(--am-divider); background: var(--am-bg-paper); color: var(--am-text-primary); font: inherit; }
.inp.focused { border-color: var(--am-text-primary); }
.inp.error { border-color: var(--am-error-main); }
.err { font-size: 11px; color: var(--am-error-main); margin-top: 3px; display: block; }
.row { display: flex; gap: 14px; align-items: center; }
.check { width: 18px; height: 18px; border-radius: 4px; border: 2px solid var(--am-text-disabled); display: inline-block; }
.check.checked { border-color: var(--am-text-primary); background: var(--am-text-primary); }
.switch { width: 34px; height: 18px; border-radius: 9px; background: var(--am-text-disabled); position: relative; display: inline-block; }
.switch .thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--am-bg-paper); position: absolute; top: 2px; left: 2px; }
.switch.on { background: var(--am-text-primary); }
.switch.on .thumb { left: 18px; }`;
  return page("Inputs & controls", "Components", body, css);
}

function surfacesCard(): string {
  const body = `
    <div class="grid">
      <div class="card">
        <div class="card-title">Latency p95</div>
        <div class="stat mono">1.84s</div>
        <div class="sub">flat, bordered, no elevation</div>
      </div>
      <div class="menu">
        <div class="mi selected">Duplicate</div>
        <div class="mi">Move to queue</div>
        <div class="mi danger">Delete</div>
      </div>
      <div class="dialog">
        <div class="dlg-title">Delete environment?</div>
        <div class="dlg-body">This removes the preview environment and its snapshot.</div>
        <div class="dlg-actions"><button class="btn btn-text">Cancel</button><button class="btn btn-danger">Delete</button></div>
      </div>
    </div>`;
  const css = `${BUTTON_CSS}
.grid { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.card { border: 1px solid var(--am-divider); border-radius: ${RADIUS.card}px; background: var(--am-bg-paper); padding: 16px; width: 170px; }
.card-title { font-size: 0.9375rem; font-weight: 600; margin-bottom: 8px; }
.stat { font-size: 1.5rem; font-weight: 600; }
.sub { font-size: 11px; color: var(--am-text-secondary); margin-top: 6px; }
.menu { border: 1px solid var(--am-divider); border-radius: ${RADIUS.overlay}px; background: var(--am-bg-paper); box-shadow: var(--am-shadow-overlay); padding: 6px; width: 160px; }
.mi { padding: 7px 10px; border-radius: ${RADIUS.chip}px; margin: 2px 4px; font-size: 0.875rem; }
.mi.selected { background: var(--am-action-selected); }
.mi.danger { color: var(--am-error-main); }
.dialog { border-radius: ${RADIUS.overlay}px; background: var(--am-bg-paper); box-shadow: var(--am-shadow-dialog); width: 300px; }
.dlg-title { font-size: 1.0625rem; font-weight: 600; padding: 20px 24px 8px; }
.dlg-body { font-size: 0.875rem; color: var(--am-text-secondary); padding: 8px 24px 20px; }
.dlg-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 24px 20px; }`;
  return page("Surfaces", "Components", body, css);
}

function feedbackCard(): string {
  const alerts = (["success", "warning", "error"] as const)
    .map(
      (sev) => `
    <div class="alert" style="background:var(--am-${sev}-lighter);color:var(--am-${sev}-dark)">Standard ${sev} alert</div>
    <div class="alert outlined" style="border-color:var(--am-${sev}-main);color:var(--am-${sev}-dark)">Outlined ${sev} alert</div>`,
    )
    .join("");
  const body = `
    <div class="stack">${alerts}</div>
    <div class="cap" style="margin-top:16px">Chips take the mono face — the trace-id vocabulary.</div>
    <div class="row">
      <span class="chip mono">trace_01HZY3</span>
      <span class="chip mono">gpt-4o</span>
      <span class="chip mono" style="background:var(--am-success-lighter);color:var(--am-success-dark)">passed</span>
      <span class="tooltip">Solid ink tooltip</span>
    </div>`;
  const css = `
.stack { display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
.alert { border-radius: ${RADIUS.control}px; padding: 10px 14px; font-weight: 500; font-size: 0.875rem; border: 1px solid transparent; }
.alert.outlined { background: transparent; }
.cap { font-size: 11px; color: var(--am-text-secondary); margin-bottom: 8px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.chip { border-radius: ${RADIUS.chip}px; padding: 4px 9px; font-size: 0.8125rem; font-weight: 500; background: var(--am-bg-neutral); }
.tooltip { border-radius: ${RADIUS.chip}px; padding: 5px 9px; font-size: 12px; font-weight: 500; background: var(--am-text-primary); color: var(--am-bg-paper); }`;
  return page("Feedback", "Components", body, css);
}

// ---------------------------------------------------------------------------

const CARDS: Record<string, string> = {
  "colors/brand.html": brandCard(),
  "colors/neutral.html": neutralCard(),
  "colors/semantic.html": semanticCard(),
  "type/scale.html": typeCard(),
  "foundations/shape-shadow.html": shapeCard(),
  "components/buttons.html": buttonsCard(),
  "components/inputs.html": inputsCard(),
  "components/surfaces.html": surfacesCard(),
  "components/feedback.html": feedbackCard(),
};

for (const [path, html] of Object.entries(CARDS)) {
  const target = join(OUT_DIR, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
}
console.log(`wrote ${Object.keys(CARDS).length} cards to ${OUT_DIR}`);
