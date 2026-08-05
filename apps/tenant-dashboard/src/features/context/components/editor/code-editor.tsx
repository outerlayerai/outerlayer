"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { lintGutter } from "@codemirror/lint";
import { useColorScheme } from "@mui/material/styles";
import type { ContextKind } from "@repo/context-core";
import { contextLinter, type ContextLintContext } from "./editor-lint";

export interface CodeEditorProps {
  kind: ContextKind;
  value: string;
  onChange: (value: string) => void;
  lintContext?: ContextLintContext;
  readOnly?: boolean;
  /** Forwarded so tests / callers can target the editor region. */
  ["data-testid"]?: string;
}

/**
 * Raw CodeMirror surface: markdown mode for every markdown kind, JSON mode for
 * `mcp.json`, both wired to the context-core linter for inline squiggles
 * (schema errors + mcp secret/shape violations). The server stays authoritative
 * on save; this is editor-time feedback only.
 */
export function CodeEditor({
  kind,
  value,
  onChange,
  lintContext,
  readOnly = false,
  ...rest
}: CodeEditorProps) {
  // CodeMirror needs a literal 'light'/'dark' (it can't consume CSS variables),
  // so resolve the ACTIVE scheme — under `cssVariables` theming,
  // `theme.palette.mode` is frozen at build time and would never flip.
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = (mode === "system" ? systemMode : mode) ?? "light";

  const dirName = lintContext?.dirName;
  const fileStem = lintContext?.fileStem;
  // Depend on the primitive lint inputs, not the (inline, per-render) context
  // object — otherwise the whole extension set rebuilds on every keystroke.
  const extensions = useMemo<Extension[]>(() => {
    const language = kind === "mcp" ? json() : markdown();
    return [language, lintGutter(), contextLinter(kind, { dirName, fileStem })];
  }, [kind, dirName, fileStem]);

  // An open CodeMirror only syncs an external `value` change lazily, and defers
  // that sync behind a keystroke latch — so a value that changes from OUTSIDE
  // the editor (e.g. a draft dropped by a conflict refresh, reverting `value`
  // to the loaded bytes) can keep displaying the stale buffer. Track the last
  // value we emitted; when the incoming `value` diverges from it the change
  // originated elsewhere, so remount the surface (bump the key) to load the
  // fresh doc. Self-edits round-trip back as an equal value and never remount,
  // preserving the cursor.
  const lastEmitRef = useRef(value);
  const [docKey, setDocKey] = useState(0);

  const handleChange = useCallback(
    (next: string) => {
      lastEmitRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  useEffect(() => {
    if (value !== lastEmitRef.current) {
      lastEmitRef.current = value;
      setDocKey((k) => k + 1);
    }
  }, [value]);

  return (
    <div
      data-testid={rest["data-testid"] ?? "context-code-editor"}
      style={{ height: "100%" }}
    >
      <CodeMirror
        key={docKey}
        value={value}
        onChange={handleChange}
        readOnly={readOnly}
        extensions={extensions}
        theme={resolvedMode === "dark" ? "dark" : "light"}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly }}
        height="100%"
        style={{ fontSize: 13, height: "100%" }}
      />
    </div>
  );
}
