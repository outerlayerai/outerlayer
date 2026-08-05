import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retightenLists } from "./retighten-lists";

/**
 * The Milkdown round-trip / change-forwarding battery runs in a real Node process
 * (esbuild-bundled harness), NOT in-process under Vitest: this repo's SSR
 * dep-optimizer partially pre-bundles @milkdown/core and the resulting
 * dual-instance makes `Editor.create()` throw `Context "nodes" not found`. See
 * test-helpers/harness-entry.ts. This spec builds the harness once, runs it, and
 * asserts on the JSON it emits. `retightenLists` (pure, no @milkdown) is imported
 * directly to cross-check the change path.
 */
interface EditScenario {
  onChangeCalls: string[];
  rawMarkdown: string;
}
interface BatteryResult {
  roundTrip: Record<string, { output: string; baseline: string }>;
  stability: Record<string, { first: string; second: string }>;
  crlfEqualsLf: { crlf: string; lf: string };
  proseEdit: EditScenario;
  listEdit: EditScenario & { source: string };
  initialLoad: { onChangeCalls: string[] };
  onReadyCount: number;
  readOnlyEditable: boolean;
  editableWhenNotReadOnly: boolean;
  link: { applied: string; updated: string; removed: string; removedSpanning: string };
  typedAtEnd: { empty: string; plain: string; htmlComment: string };
}

const supportDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-helpers");
const appRoot = path.resolve(supportDir, "../../../../..");
const bundlePath = path.join(
  appRoot,
  "node_modules/.cache/rich-editor-harness",
  `harness-${process.pid}.mjs`,
);

let battery: BatteryResult;

beforeAll(async () => {
  mkdirSync(path.dirname(bundlePath), { recursive: true });
  await build({
    entryPoints: [path.join(supportDir, "harness-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: bundlePath,
    external: ["jsdom"],
    logLevel: "silent",
    // Some bundled CJS deps expect `require`; provide it in the ESM output.
    banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  });
  const stdout = execFileSync(process.execPath, [bundlePath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, RICH_HARNESS_SUPPORT_DIR: supportDir },
  });
  battery = JSON.parse(stdout) as BatteryResult;
}, 60_000);

afterAll(() => {
  rmSync(bundlePath, { force: true });
});

describe("Milkdown round-trip fidelity (regression pins at v7.21.2)", () => {
  it("serializes each spike fixture byte-identically to its recorded baseline", () => {
    for (const [name, { output, baseline }] of Object.entries(battery.roundTrip)) {
      expect(output, `first-load fidelity for ${name}`).toBe(baseline);
    }
  });

  it("is byte-stable on the second pass for every fixture", () => {
    for (const [name, { first, second }] of Object.entries(battery.stability)) {
      expect(second, `second-pass stability for ${name}`).toBe(first);
    }
  });

  it("normalizes CRLF input to exactly the same bytes as its LF-authored twin", () => {
    expect(battery.crlfEqualsLf.crlf).toBe(battery.crlfEqualsLf.lf);
  });
});

describe("change forwarding through configureRichEditor", () => {
  it("does not fire onChange for the initial load (only genuine edits)", () => {
    expect(battery.initialLoad.onChangeCalls).toEqual([]);
  });

  it("forwards the exact edited markdown for a prose edit (retighten is a no-op)", () => {
    expect(battery.proseEdit.onChangeCalls).toEqual(["Hello world\n"]);
  });

  it("retightens the forwarded markdown when the source list was tight", () => {
    const { onChangeCalls, rawMarkdown, source } = battery.listEdit;
    // Milkdown's own serialization loosens the list (blank lines between items)...
    expect(rawMarkdown).toBe("* a\n\n* b\n\n* X\n");
    // ...but the change delivered to the consumer is the retightened form...
    expect(onChangeCalls).toEqual(["* a\n* b\n* X\n"]);
    // ...which is exactly retightenLists(rawSerialization, source).
    expect(onChangeCalls).toEqual([retightenLists(rawMarkdown, source)]);
  });

  it("fires onReady exactly once after mount", () => {
    expect(battery.onReadyCount).toBe(1);
  });
});

describe("link popover serialization", () => {
  it("wraps the selection in a link with the entered URL", () => {
    expect(battery.link.applied).toBe("[selected](https://entered.url)\n");
  });

  it("updates an existing link's href in place", () => {
    expect(battery.link.updated).toBe("[selected](https://new.url)\n");
  });

  it("strips the link back to plain text on remove", () => {
    expect(battery.link.removed).toBe("selected\n");
  });

  it("strips a link spanning multiple inline nodes fully, leaving no dangling link", () => {
    // The link wraps a strong node and a plain-text node; removal must clear
    // both, not leave `[plain](https://x.dev)` behind.
    expect(battery.link.removedSpanning).toBe("**bold** plain\n");
  });
});

describe("typing at the document end (link-selection listener regression)", () => {
  // The toolbar reads link context on every selection change; the listener fires
  // the post-change selection against the pre-change (smaller) state, so a caret
  // typed at the doc end overshoots an unclamped boundary probe and the throw
  // aborts the keystroke. Each char below is typed at the very end — all must land.
  it("keeps every keystroke typed into an empty document", () => {
    expect(battery.typedAtEnd.empty).toBe("abc\n");
  });

  it("keeps every keystroke typed at the end of a plain document", () => {
    expect(battery.typedAtEnd.plain).toBe("helloabc\n");
  });

  it("keeps every keystroke typed after a trailing HTML comment", () => {
    expect(battery.typedAtEnd.htmlComment).toBe("text\n\n<!-- note -->abc\n");
  });
});

describe("readOnly gating", () => {
  it("resolves the ProseMirror view as non-editable when readOnly", () => {
    expect(battery.readOnlyEditable).toBe(false);
  });

  it("resolves the ProseMirror view as editable when not readOnly", () => {
    expect(battery.editableWhenNotReadOnly).toBe(true);
  });
});
