/**
 * Pure split + parse of a context file's leading YAML frontmatter block.
 * `parseContextFile` never throws — malformed or
 * non-mapping frontmatter YAML resolves to `frontmatter: null`, which
 * downstream `validateFrontmatter` naturally rejects for kinds that require
 * fields (schema validation against `{}` fails on missing-required-field,
 * same as against genuinely absent frontmatter).
 */
import { parseDocument } from 'yaml';
import type { ParsedContextFile } from '../kinds';

export interface SplitRawFile {
  /** YAML text between the `---` delimiters, or `null` if there's no frontmatter block at all. */
  frontmatterInner: string | null;
  body: string;
  lineEnding: 'lf' | 'crlf';
}

const OPEN_LF = '---\n';
const OPEN_CRLF = '---\r\n';

/** Splits raw file content into its frontmatter block (if any) and body, preserving line-ending style. */
export function splitRawFile(raw: string): SplitRawFile {
  const lineEnding: 'lf' | 'crlf' = raw.includes('\r\n') ? 'crlf' : 'lf';
  const open = lineEnding === 'crlf' ? OPEN_CRLF : OPEN_LF;

  if (!raw.startsWith(open)) {
    return { frontmatterInner: null, body: raw, lineEnding };
  }

  const closingMid = lineEnding === 'crlf' ? '\r\n---\r\n' : '\n---\n';
  const closingEof = lineEnding === 'crlf' ? '\r\n---' : '\n---';

  // For an EMPTY frontmatter block, the opening line's trailing newline IS the
  // closing line's leading newline (there's no content between them) — rewind
  // the search start by one newline-sequence-length so that shared boundary is
  // still in the search window, or the closing delimiter is missed entirely.
  const newlineLength = lineEnding === 'crlf' ? 2 : 1;
  let closeIdx = raw.indexOf(closingMid, open.length - newlineLength);
  let blockEnd: number;
  if (closeIdx !== -1) {
    blockEnd = closeIdx + closingMid.length;
  } else if (raw.endsWith(closingEof) && raw.length > open.length) {
    closeIdx = raw.length - closingEof.length;
    blockEnd = raw.length;
  } else {
    // No closing delimiter — the leading `---` was not a frontmatter block.
    return { frontmatterInner: null, body: raw, lineEnding };
  }

  return {
    frontmatterInner: raw.slice(open.length, closeIdx),
    body: raw.slice(blockEnd),
    lineEnding,
  };
}

/** Parses a context file's frontmatter block and body. Never throws. */
export function parseContextFile(raw: string): ParsedContextFile {
  const { frontmatterInner, body } = splitRawFile(raw);

  if (frontmatterInner === null) {
    return { frontmatter: null, body, raw };
  }

  const yamlText = frontmatterInner.replace(/\r\n/g, '\n');
  if (yamlText.trim().length === 0) {
    return { frontmatter: {}, body, raw };
  }

  try {
    const doc = parseDocument(yamlText);
    if (doc.errors.length > 0) {
      return { frontmatter: null, body, raw };
    }
    const value = doc.toJS();
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { frontmatter: value as Record<string, unknown>, body, raw };
    }
    return { frontmatter: null, body, raw };
  } catch {
    return { frontmatter: null, body, raw };
  }
}
