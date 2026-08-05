/**
 * The agent-session converter stores turn I/O in the OTLP gen_ai messages wire
 * shape — `[{"role":"user","content":"…"}]` — because the Input/Output columns
 * are shared with every span producer. Facet extraction must see the WORDS,
 * not the envelope: an un-unwrapped turn feeds the model (and the mock's
 * vocabulary clustering) `role`/`content` boilerplate instead of the actual
 * text. Both the whole-trace task preprocessor and the steering renderer run
 * this before handing text to a model.
 *
 * Only the exact messages-array shape is unwrapped; plain strings, tool JSON
 * payloads, and anything else pass through untouched. Mirrors the transcript
 * UI's unwrap (dashboard sessions detail route) so enrichment and display
 * agree on what a turn "says".
 */
export function unwrapMessages(raw: string): string {
  if (raw[0] !== '[') return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((m) => typeof m === 'object' && m !== null && 'role' in m && 'content' in m)
    ) {
      return (parsed as { content: unknown }[])
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
    }
  } catch {
    /* not the messages shape — fall through */
  }
  return raw;
}
