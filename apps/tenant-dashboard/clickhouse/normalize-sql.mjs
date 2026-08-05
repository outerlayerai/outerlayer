/**
 * Comment-insensitive normalization for ClickHouse migration files.
 *
 * The migration runner checksums file content to detect drift in APPLIED
 * migrations. Comments are documentation, not schema — editing them must not
 * count as drift. Checksums are therefore computed over this normalized form.
 *
 * Only FULL-LINE comments (optional whitespace then `--`) are stripped.
 * Trailing `--` on a code line is left alone: `--` inside a string literal
 * is valid SQL data, and distinguishing the two requires a real parser.
 * A comment edit that shares a line with code still counts as drift — put
 * comments on their own line.
 */

export function normalizeSql(content) {
  const lines = content.split('\n');
  const kept = [];
  for (const line of lines) {
    if (/^\s*--/.test(line)) continue;
    kept.push(line.replace(/\s+$/, ''));
  }
  // Collapse runs of blank lines and trim leading/trailing blanks so
  // adding or removing a comment block never changes surrounding spacing.
  const out = [];
  for (const line of kept) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
