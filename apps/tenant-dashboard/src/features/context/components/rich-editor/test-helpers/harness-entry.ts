/**
 * Headless Milkdown battery, executed in a real Node process (via `tsx`) rather
 * than in-process under Vitest.
 *
 * Why a subprocess: Vitest's SSR dep-optimizer (enabled in this repo for the
 * @mui/x chain) partially pre-bundles @milkdown/core, so the `nodesCtx` slice it
 * injects is a different object than the one @milkdown/preset-commonmark resolves
 * — Milkdown then throws `Context "nodes" not found` at `create()`. Running the
 * editor through Node's own module resolution loads a single @milkdown instance
 * (exactly as the O-2 spike harness did), sidestepping the dual-instance issue
 * without touching the shared Vitest config. The Vitest spec spawns this and
 * asserts on the JSON it prints.
 *
 * It exercises the *production* source (`configureRichEditor`, `applyMarkdownPresets`,
 * `retightenLists`) via editor-harness, so this is not a re-implementation.
 */
import {
  ROUND_TRIP_FIXTURES,
  mountConfiguredEditor,
  readBaseline,
  readFixture,
  roundTripMarkdown,
  typeAtDocEndWithLinkProbe,
} from "./editor-harness";

// plugin-listener debounces markdownUpdated internally (~200ms); wait past it.
const LISTENER_SETTLE_MS = 350;
const settle = () => new Promise((resolve) => setTimeout(resolve, LISTENER_SETTLE_MS));

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
  /** Serialized markdown after the link popover's set / update / remove paths. */
  link: { applied: string; updated: string; removed: string; removedSpanning: string };
  /** Markdown after typing at the doc end with the live link-selection listener. */
  typedAtEnd: { empty: string; plain: string; htmlComment: string };
}

async function run(): Promise<BatteryResult> {
  const roundTrip: BatteryResult["roundTrip"] = {};
  const stability: BatteryResult["stability"] = {};
  for (const { name, fixture, baseline } of ROUND_TRIP_FIXTURES) {
    const output = await roundTripMarkdown(readFixture(fixture));
    const baselineText = readBaseline(baseline);
    roundTrip[name] = { output, baseline: baselineText };
    stability[name] = { first: baselineText, second: await roundTripMarkdown(baselineText) };
  }

  const crlfEqualsLf = {
    crlf: await roundTripMarkdown(readFixture("c2-edge-constructs-crlf.md")),
    lf: await roundTripMarkdown(readFixture("c-edge-constructs.md")),
  };

  // Prose edit — retighten is a no-op (no lists).
  const proseCalls: string[] = [];
  const proseEditor = await mountConfiguredEditor({
    value: "Hello",
    onChange: (md) => proseCalls.push(md),
  });
  proseEditor.insertTextAtEnd(" world");
  await settle();
  const proseEdit: EditScenario = { onChangeCalls: proseCalls, rawMarkdown: proseEditor.getMarkdown() };
  await proseEditor.destroy();

  // List edit — Milkdown loosens; the forwarded change is retightened.
  const listSource = "- a\n- b\n";
  const listCalls: string[] = [];
  const listEditor = await mountConfiguredEditor({
    value: listSource,
    onChange: (md) => listCalls.push(md),
  });
  listEditor.insertTextAtEnd("X");
  const listRaw = listEditor.getMarkdown();
  await settle();
  const listEdit = { onChangeCalls: listCalls, rawMarkdown: listRaw, source: listSource };
  await listEditor.destroy();

  // Initial load must not fire onChange.
  const initialCalls: string[] = [];
  const idleEditor = await mountConfiguredEditor({
    value: "# Title\n\nBody text.\n",
    onChange: (md) => initialCalls.push(md),
  });
  await settle();
  const initialLoad = { onChangeCalls: initialCalls };
  await idleEditor.destroy();

  // onReady fires once.
  let onReadyCount = 0;
  const readyEditor = await mountConfiguredEditor({
    value: "hi",
    onChange: () => {},
    onReady: () => {
      onReadyCount += 1;
    },
  });
  await readyEditor.destroy();

  // readOnly gating.
  const roEditor = await mountConfiguredEditor({ value: "locked", readOnly: true, onChange: () => {} });
  const readOnlyEditable = roEditor.isEditable();
  await roEditor.destroy();

  const rwEditor = await mountConfiguredEditor({ value: "open", readOnly: false, onChange: () => {} });
  const editableWhenNotReadOnly = rwEditor.isEditable();
  await rwEditor.destroy();

  // Link popover paths, exercised through the production link module over a real
  // selection. "selected" spans doc positions 1..9.
  const linkApplyEditor = await mountConfiguredEditor({ value: "selected", onChange: () => {} });
  linkApplyEditor.setSelection(1, 9);
  linkApplyEditor.applyLink("https://entered.url");
  const linkApplied = linkApplyEditor.getMarkdown();
  await linkApplyEditor.destroy();

  const linkUpdateEditor = await mountConfiguredEditor({
    value: "[selected](https://old.url)",
    onChange: () => {},
  });
  linkUpdateEditor.setSelection(2, 2); // cursor inside the existing link
  linkUpdateEditor.applyLink("https://new.url");
  const linkUpdated = linkUpdateEditor.getMarkdown();
  await linkUpdateEditor.destroy();

  const linkRemoveEditor = await mountConfiguredEditor({
    value: "[selected](https://entered.url)",
    onChange: () => {},
  });
  linkRemoveEditor.setSelection(2, 2);
  linkRemoveEditor.removeLink();
  const linkRemoved = linkRemoveEditor.getMarkdown();
  await linkRemoveEditor.destroy();

  // Remove a link spanning two inline nodes (strong + plain text): the whole
  // link must go, not just the first node.
  const linkSpanEditor = await mountConfiguredEditor({
    value: "[**bold** plain](https://x.dev)",
    onChange: () => {},
  });
  linkSpanEditor.setSelection(2, 2); // cursor inside the bold segment of the link
  linkSpanEditor.removeLink();
  const linkRemovedSpanning = linkSpanEditor.getMarkdown();
  await linkSpanEditor.destroy();

  // Typing at the document end with the live selection listener active: the
  // listener reads link context on every selection change, and an unclamped
  // boundary probe throws against the pre-change state, dropping the keystroke.
  const typedAtEnd = {
    empty: await typeAtDocEndWithLinkProbe("", "abc"),
    plain: await typeAtDocEndWithLinkProbe("hello", "abc"),
    htmlComment: await typeAtDocEndWithLinkProbe("text\n\n<!-- note -->", "abc"),
  };

  return {
    roundTrip,
    stability,
    crlfEqualsLf,
    proseEdit,
    listEdit,
    initialLoad,
    onReadyCount,
    readOnlyEditable,
    editableWhenNotReadOnly,
    link: {
      applied: linkApplied,
      updated: linkUpdated,
      removed: linkRemoved,
      removedSpanning: linkRemovedSpanning,
    },
    typedAtEnd,
  };
}

run()
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err));
    process.exit(1);
  });
