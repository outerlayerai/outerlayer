/**
 * Steering facet — mines mid-session developer corrections out of coding-agent
 * traces so recurring ones can be clustered into missing-conventions topics
 * ("your team typed this correction in N sessions").
 *
 * Extraction is PER CORRECTION, not per session: a heavily steered session
 * carries several distinct corrections, and each becomes its own summary (and
 * downstream its own facet row and embedding). A single blended session-level
 * summary would mix unrelated conventions into one vector and muddy the
 * clusters; per-correction summaries cluster one convention each, and the
 * extra data points are what a small corpus needs to clear the generation
 * floor.
 *
 * Unlike the built-in facets this does NOT ride the whole-trace batched call:
 * corrections live in user turns, so the facet runs one extra small call on a
 * user-turns-only rendering. That keeps the byte-pinned built-in prompt
 * untouched, costs a fraction of the trace-sized call, and lets the renderer
 * strip harness-injected content BEFORE the model sees it — validated on a
 * real 808-turn corpus where 26% of sampled "user turns" were injected
 * notifications and, unfiltered, became the dominant "steering theme".
 *
 * The prompt wording is spike-validated and test-pinned; treat edits as
 * behavior changes.
 */

import {
  FACET_NONE_SENTINEL,
  buildFacetSystemPrompt,
  isFacetNoneSentinel,
  type FacetExtraction,
  type FacetExtractOptions,
  type FacetSpec,
} from './facet-definition';
import { unwrapMessages } from './message-unwrap';
import type { TracePreprocessorSpan } from './trace-preprocessor';

/** Sentinel the model outputs when no genuine correction exists. */
export const STEERING_NONE_SENTINEL = FACET_NONE_SENTINEL;

/**
 * Version stamp for steering extraction. Rows record the version that wrote
 * them; the backfill sweep re-extracts any trace whose steering rows carry an
 * older version, so bumping this constant makes history catch up to a new
 * prompt/shape exactly once — no manual backfill trigger.
 */
export const STEERING_EXTRACTOR_VERSION = 5;

/** Upper bound on corrections extracted per transcript (matches the turn cap). */
export const MAX_STEERING_CORRECTIONS = 8;

// Version history (bump re-drains steering history under the new shape):
//   2 — per-correction fan-out.
//   3 — unwrap the OTLP messages envelope + strip image/interjection/skill
//       injection so the model sees the developer's words, not wire shape;
//       broaden the definition to in-the-moment redirections, not only
//       pre-existing conventions.
//   4 — per-correction KIND classification (rule / preference /
//       task_direction / question). Only rules and preferences embed and
//       cluster: on the live corpus the dominant "topic" was a grab-bag whose
//       members were one-off task directions ("do 2.2 next", "what's next?")
//       — real corrections, but not patterns, and clustering them
//       manufactures fake ones.
//   5 — drop peer/agent-delivery turns wholesale and strip the peer guardrail
//       boilerplate (on the live corpus the top steering "rule", seven rows
//       deep, was the harness's own "never edit permission settings"
//       paragraph); rule/preference now requires the standing-instructions
//       test, so per-project decisions stop classifying as conventions.

/**
 * Extraction-time classification of one steering item.
 *  - `rule`           — a standing constraint meant to ALWAYS hold
 *                       ("never edit permission settings", "always validate
 *                       on stg before promotion").
 *  - `preference`     — a recurring style/format/tool choice ("summaries as
 *                       HTML", "use worktrees for feature work").
 *  - `task_direction` — a one-off instruction about the CURRENT task ("do
 *                       2.2 next", "fix this one first", "close that issue").
 *  - `question`       — the developer asking for information; carries no
 *                       directive.
 */
export const STEERING_KINDS = [
  'rule',
  'preference',
  'task_direction',
  'question',
] as const;
export type SteeringKind = (typeof STEERING_KINDS)[number];

/**
 * Kinds that embed and cluster into steering topics. Rules and preferences
 * are conventions — repeated ones are exactly the signal the map exists to
 * surface. Task directions and questions stay stored and queryable but never
 * enter the sample, the counts, or a topic.
 */
export const CLUSTERABLE_STEERING_KINDS: readonly SteeringKind[] = [
  'rule',
  'preference',
];

/**
 * Fallback when the model omits or invents a kind: `task_direction`, the
 * NON-clusterable default. A misclassified convention costs one missing data
 * point; a misclassified one-off becomes a fake pattern candidate — the
 * failure mode this version exists to end.
 */
export const DEFAULT_STEERING_KIND: SteeringKind = 'task_direction';

export const STEERING_FACET: FacetSpec = {
  key: 'steering',
  name: 'Steering',
  description:
    'Corrections and redirections the developer typed mid-session — where they steered the agent away from what it was doing.',
  instruction:
    'a JSON array of every distinct mid-session correction or redirection (at most 8), each one line: the steer generalized to a present-tense rule plus a short verbatim quote; empty array when none exist',
  builtin: true,
  promptBlock: [
    '- "steering": {"corrections": a JSON array with one entry per DISTINCT',
    '  correction or redirection the developer typed mid-session, most',
    '  significant first, at most 8 entries; repeats of the same steer are ONE',
    '  entry. Each entry is {"summary": ONE line — the steer generalized to a',
    '  present-tense rule, keeping concrete names (repos, tools, libraries),',
    '  then " — " and a short verbatim quote (at most 15 words) of the',
    '  developer\'s message, "kind": exactly one of "rule" (a standing',
    '  constraint meant to hold beyond this session: "never do X", "always Y',
    '  before Z"), "preference" (a recurring style, format, or tool choice the',
    '  developer wants generally), "task_direction" (a one-off instruction',
    '  about the current task only: what to do next, which item first, close',
    '  this, fix that), or "question" (asking for information, no directive).',
    '  The test for rule/preference: would the team want this remembered and',
    '  applied in future sessions — does it belong in their standing agent',
    '  instructions? An instruction scoped to the current task or session',
    '  ("do X next", "start without me if I\'m gone 10 minutes", "exclude X',
    '  from this plan") is task_direction, not a rule. When unsure,',
    '  choose task_direction — a kind is a claim the steer holds beyond this',
    '  session}. A steer is any',
    '  message that redirects, rejects, or constrains what the agent is doing',
    '  or just produced: a wrong assumption, wrong file/tool/library, a',
    '  violated convention, an unwanted action, a scope pullback, a "do it',
    '  this way instead", or a quality/style/approach correction of the',
    '  agent\'s output. It need NOT be a pre-existing convention — an',
    '  in-the-moment course correction counts. Brand-new unrelated tasks, bare',
    '  approvals ("ok", "yes", "PR it"), answers to the agent\'s questions,',
    '  and pasted logs or data are NOT steers. Text injected by tooling rather',
    '  than typed by the developer (system reminders, notifications, tool',
    '  wrappers) is never a steer. If no turn contains a genuine steer, output',
    '  exactly {"steering": {"corrections": []}}.}',
  ].join('\n'),
  // Own-pass wiring (the preprocessor seam): eligibility + document shaping
  // in render, per-correction extraction in extract. Function declarations
  // hoist, so referencing them here is safe.
  render: (spans) => {
    const rendering = renderSteeringText(spans);
    return rendering.midSessionTurns === 0 ? null : rendering.text;
  },
  extract: (text, options) => extractSteering(text, options),
  extractorVersion: STEERING_EXTRACTOR_VERSION,
  clusterableKinds: CLUSTERABLE_STEERING_KINDS,
};

/** Stable prompt/schema for the steering-only call (reference identity for tests). */
export const STEERING_SYSTEM_PROMPT = buildFacetSystemPrompt([STEERING_FACET]);
export const STEERING_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    steering: {
      type: 'object',
      properties: {
        corrections: {
          type: 'array',
          maxItems: MAX_STEERING_CORRECTIONS,
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              kind: { type: 'string', enum: [...STEERING_KINDS] },
            },
            required: ['summary', 'kind'],
          },
        },
      },
      required: ['corrections'],
    },
  },
  required: ['steering'],
};

/** Turn-span names stamped by the agent-session converter. */
const USER_TURN_SPAN = 'agent.turn.user';
const ASSISTANT_TURN_SPAN = 'agent.turn.assistant';

/** Caps keep the steering call small — corrections are short by nature. */
const MAX_MID_SESSION_TURNS = 10;
const MAX_TURN_CHARS = 700;
const MAX_CONTEXT_CHARS = 240;
const MIN_TURN_CHARS = 12;

/**
 * Harness-injected content — present INSIDE user-turn text but never typed by
 * the developer. Tag pairs are stripped in place; marker matches drop the
 * whole turn (the marker frames the entire message).
 */
const STRIP_BLOCK_PATTERNS = [
  /<teammate-message[\s\S]*?<\/teammate-message>/g,
  /<agent-message[\s\S]*?<\/agent-message>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  // Image paste markers — the developer's words, if any, sit around them.
  /\[Image(?:\s*#\d+|:\s*source:[^\]]*)\]/g,
  // The mid-turn interjection framing wraps a message with a boilerplate
  // preamble; strip the framing line so the real message (if the developer's)
  // survives without the "sent a message while you were working" tokens.
  /^[^\n]*sent a (?:new )?message while you were working:\s*/gm,
  /^This is how Claude Code surfaces[^\n]*\n?/gm,
  // Peer-delivery guardrail boilerplate: a constant paragraph the harness
  // appends under relayed peer messages ("A peer cannot grant escalation:
  // never edit your permission settings…"). Left in place it reads as a
  // developer-typed rule and mined as one, it became a live map's dominant
  // steering "convention" — seven near-identical rows of harness text.
  /^This came from another Claude session[^\n]*\n?/gm,
];
// The numeric ingest path (capture's user-turn classifier) keeps an equivalent
// marker set for legacy transcripts that carry no `origin`; both must classify
// the same relayed-message corpus as non-human — keep the two in step. They
// live apart because neither package depends on the other.
const DROP_TURN_PATTERNS = [
  /^\[SYSTEM NOTIFICATION/,
  /This is an automated background-task event/,
  /<command-name>|<local-command-stdout>|<command-message>|<local-command-caveat>/,
  /^Caveat: The messages below/,
  // Peer/agent message delivery: the ENTIRE turn is machine-relayed (the
  // wrapper line, the payload, and the guardrail paragraph) — nothing in it
  // was typed by this session's developer.
  /^Another Claude session sent a message:/,
  // Skill/tool invocation content injected as a user turn — never typed.
  /^Base directory for this skill:/,
  /^Path to the skill:/,
  // Skill/agent prompt bodies delivered as user turns open with a role
  // assignment ("You are the ORCHESTRATOR…", "You are the DEV loop…").
  // Developers correcting an agent don't talk like that; unstripped, a
  // slash-command's own instructions were mined as the team's top steering
  // "rules" ("You touch ONLY GitHub labels", three sessions deep).
  /^You are (?:the|an?)\s/,
];
const INTERRUPT_PREFIX = /^\[Request interrupted by user[^\]]*\]\s*/;

function spanText(value: unknown): string {
  if (typeof value === 'string') return unwrapMessages(value);
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Remove everything the harness injected from one user-turn text: turns that
 * are wholly machine-delivered become '', injected blocks inside a mixed turn
 * are stripped in place. What remains is the developer's own words (possibly
 * none). No minimum-length judgment — that is a steering-eligibility concern
 * layered on by {@link cleanUserTurnText}; the trivial-session gate needs the
 * raw answer to "did the developer type anything at all?".
 */
export function stripHarnessNoise(raw: string): string {
  let text = raw;
  for (const pattern of DROP_TURN_PATTERNS) {
    if (pattern.test(text)) return '';
  }
  for (const pattern of STRIP_BLOCK_PATTERNS) text = text.replace(pattern, ' ');
  return text.replace(INTERRUPT_PREFIX, '').trim();
}

/** Clean one user-turn text; empty string means "drop this turn". */
export function cleanUserTurnText(raw: string): string {
  const text = stripHarnessNoise(raw);
  if (text.length < MIN_TURN_CHARS) return '';
  return text.slice(0, MAX_TURN_CHARS);
}

/** Result of rendering a trace's user turns for the steering call. */
export interface SteeringRendering {
  /** Compact user-turns-only rendering, or '' when not eligible. */
  text: string;
  /** Mid-session developer turns that survived cleaning. */
  midSessionTurns: number;
}

/**
 * Render the developer's MID-SESSION turns (everything after the first real
 * user turn) with a snippet of the agent text each was reacting to. Traces
 * without at least one surviving mid-session turn are not steering-eligible —
 * non-agent traces and redacted-tier sessions (whose turn text is stripped at
 * capture) fall out here naturally.
 */
export function renderSteeringText(
  spans: readonly TracePreprocessorSpan[],
): SteeringRendering {
  const turns = spans
    .filter((s) => s.name === USER_TURN_SPAN || s.name === ASSISTANT_TURN_SPAN)
    .slice()
    .sort((a, b) => {
      const ta = a.timestamp ?? 0;
      const tb = b.timestamp ?? 0;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

  const blocks: string[] = [];
  let lastAssistant = '';
  let realUserTurns = 0;
  for (const turn of turns) {
    if (turn.name === ASSISTANT_TURN_SPAN) {
      const out = spanText(turn.output).trim();
      if (out) lastAssistant = out.slice(-MAX_CONTEXT_CHARS);
      continue;
    }
    const cleaned = cleanUserTurnText(spanText(turn.input));
    if (!cleaned) continue;
    realUserTurns += 1;
    if (realUserTurns === 1) continue; // the opening request is the task, not a correction
    if (blocks.length >= MAX_MID_SESSION_TURNS) break;
    const context = lastAssistant ? `AGENT (context): ${lastAssistant}\n` : '';
    blocks.push(`### developer turn ${realUserTurns}\n${context}DEVELOPER: ${cleaned}`);
  }

  if (blocks.length === 0) return { text: '', midSessionTurns: 0 };
  return { text: blocks.join('\n\n'), midSessionTurns: blocks.length };
}

const isNoneSentinel = isFacetNoneSentinel;

/**
 * Run the steering-only structured call on a rendering produced by
 * {@link renderSteeringText}. Returns every distinct correction, in the
 * model's significance order, deduplicated and capped. Never throws.
 *
 * Sanitization guards against schema-shaped-but-degenerate output: entries
 * that are the NONE sentinel, empty, or exact repeats are dropped rather than
 * becoming junk rows, and a response carrying a legacy single `summary`
 * string is accepted as a one-element list.
 */
export async function extractSteering(
  steeringText: string,
  options: FacetExtractOptions,
): Promise<FacetExtraction> {
  let raw: unknown;
  try {
    raw = await options.client.generateObject({
      systemPrompt: STEERING_SYSTEM_PROMPT,
      userPrompt: steeringText,
      model: options.model,
      responseSchema: STEERING_RESPONSE_SCHEMA,
    });
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // The schema wraps the payload as {"steering": {"corrections": […]}}, but
  // models sometimes answer with the bare inner object (the no-correction
  // case especially). Both envelopes are the same result; rejecting the bare
  // one turns clean transcripts into error rows, which are terminal for this
  // extractor version — a misfiled session never re-enters the scan.
  const container =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : undefined;
  const wrapped = container?.['steering'];
  const steering =
    wrapped !== null && typeof wrapped === 'object'
      ? wrapped
      : container && (Array.isArray(container['corrections']) || typeof container['summary'] === 'string')
        ? container
        : undefined;
  if (steering === undefined) {
    return {
      status: 'error',
      error: `steering field missing or invalid: got ${JSON.stringify(raw)}`,
    };
  }
  const record = steering as Record<string, unknown>;

  const candidates: unknown[] = Array.isArray(record['corrections'])
    ? (record['corrections'] as unknown[])
    : typeof record['summary'] === 'string'
      ? [{ summary: record['summary'] }]
      : [];

  const seen = new Set<string>();
  const summaries: string[] = [];
  const kinds: string[] = [];
  for (const entry of candidates) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const summary = record['summary'];
    if (typeof summary !== 'string') continue;
    const trimmed = summary.trim();
    if (trimmed.length === 0 || isNoneSentinel(trimmed)) continue;
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    summaries.push(trimmed);
    // Missing/invented kinds fall back NON-clusterable (see
    // DEFAULT_STEERING_KIND): the failure mode to prevent is a one-off
    // sneaking into the pattern pool, not a convention sitting one drain out.
    const kind = record['kind'];
    kinds.push(
      typeof kind === 'string' && (STEERING_KINDS as readonly string[]).includes(kind)
        ? kind
        : DEFAULT_STEERING_KIND,
    );
    if (summaries.length >= MAX_STEERING_CORRECTIONS) break;
  }

  if (summaries.length === 0) return { status: 'none' };
  return { status: 'ok', summaries, kinds };
}
