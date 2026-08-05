/**
 * Serializes a `ParsedContextFile` back to text. Byte-stable for untouched
 * input: if `file.frontmatter`/`file.body` are unchanged from what
 * `file.raw` itself parses to, `file.raw` is returned verbatim. Otherwise the
 * frontmatter block is rebuilt from a `yaml` Document seeded from the
 * *original* frontmatter text (via `file.raw`, re-split), so only the keys
 * that actually differ are touched — unknown/untouched keys keep their
 * original formatting.
 */
import { Document, parseDocument, type YAMLMap } from 'yaml';
import { parseContextFile, splitRawFile, type ParsedContextFile } from '@outerlayer/context-format';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

export function serializeContextFile(file: ParsedContextFile): string {
  const originalParsed = parseContextFile(file.raw);

  if (file.body === originalParsed.body && deepEqual(originalParsed.frontmatter, file.frontmatter)) {
    return file.raw;
  }

  const original = splitRawFile(file.raw);
  const doc = original.frontmatterInner !== null ? parseDocument(original.frontmatterInner) : new Document({});
  if (doc.contents === null) {
    doc.contents = doc.createNode({});
  }

  const originalFrontmatter = originalParsed.frontmatter;
  const nextFrontmatter = file.frontmatter;

  const prevKeys = originalFrontmatter ? Object.keys(originalFrontmatter) : [];
  const nextKeys = nextFrontmatter ? Object.keys(nextFrontmatter) : [];

  for (const key of prevKeys) {
    if (!nextFrontmatter || !(key in nextFrontmatter)) doc.delete(key);
  }
  for (const key of nextKeys) {
    const nextValue = nextFrontmatter![key];
    if (!deepEqual(originalFrontmatter?.[key], nextValue)) doc.set(key, nextValue);
  }

  const map = doc.contents as YAMLMap;
  const hasKeys = 'items' in map && Array.isArray(map.items) && map.items.length > 0;

  if (!hasKeys) return file.body;

  let yamlText = doc.toString();
  if (!yamlText.endsWith('\n')) yamlText += '\n';
  let frontmatterBlock = `---\n${yamlText}---\n`;
  if (original.lineEnding === 'crlf') frontmatterBlock = frontmatterBlock.replace(/\n/g, '\r\n');

  return frontmatterBlock + file.body;
}
