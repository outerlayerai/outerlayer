/**
 * Prompt-quality eval for the topics extraction layer — run it BEFORE
 * shipping any change to the facet prompts, the steering renderer, or the
 * trivial-session gate, instead of regenerating maps on a live environment
 * to see what happens.
 *
 *   TOPICS_EVAL_API_KEY=sk-… yarn eval            (from packages/trace-topics)
 *   TOPICS_EVAL_MODEL=gpt-5-nano                  (default; extraction model)
 *   TOPICS_EVAL_BASE_URL=https://api.openai.com/v1 (default; any compatible host)
 *
 * Runs the WORKING-TREE prompts through a real model over the synthetic
 * fixtures in ./fixtures.ts (each modeled on a live failure class) and
 * asserts the contract per category. Exit code 1 on any failure, so it can
 * gate a release checklist. Deliberately NOT part of vitest/CI: it spends
 * provider tokens and needs a key.
 *
 * The deterministic layers (gate, renderer stripping, validator tolerance)
 * are ALSO covered by unit tests; this eval exists for the judgment calls
 * only a real model exercises.
 */
import {
  BUILTIN_FACET_SPECS,
  STEERING_FACET,
  OpenAICompatibleClient,
  extractSteering,
  isFacetNoneSentinel,
  isHarnessOnlySession,
  preprocessTraceToText,
  summarizeFacetSpecs,
} from '../src/index';
import { FIXTURES, type Fixture } from './fixtures';

const apiKey = process.env['TOPICS_EVAL_API_KEY'];
if (!apiKey) {
  console.error('TOPICS_EVAL_API_KEY is required (an OpenAI-compatible key).');
  process.exit(2);
}
const model = process.env['TOPICS_EVAL_MODEL'] ?? 'gpt-5-nano';
const client = new OpenAICompatibleClient({
  apiKey,
  baseUrl: process.env['TOPICS_EVAL_BASE_URL'] ?? 'https://api.openai.com/v1',
});

interface Verdict { key: string; pass: boolean; detail: string }
const verdicts: Verdict[] = [];
const record = (key: string, pass: boolean, detail: string) => {
  verdicts.push({ key, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${key} — ${detail.slice(0, 160)}`);
};

async function evalFixture(f: Fixture): Promise<void> {
  const gated = isHarnessOnlySession(f.spans);
  if (f.category === 'gate') {
    record(f.key, gated, gated ? 'trivial gate fired — no model call would be made' : 'gate MISSED a harness-only session');
    return;
  }
  if (gated) {
    record(f.key, false, 'gate over-fired on a session with developer-typed content');
    return;
  }

  if (f.category === 'steerDrop' || f.category === 'steerKind') {
    const doc = STEERING_FACET.render!(f.spans);
    if (doc === null) {
      record(f.key, f.category === 'steerDrop', 'no steering-eligible turns after cleaning');
      return;
    }
    if (f.category === 'steerDrop' && /permission settings|Another Claude session|Review report/i.test(doc)) {
      record(f.key, false, 'relayed peer/agent content survived the steering render');
      return;
    }
    const extraction = await extractSteering(doc, { client, model });
    if (extraction.status === 'error') {
      record(f.key, false, `extraction error: ${extraction.error.slice(0, 120)}`);
      return;
    }
    const kinds = extraction.status === 'ok' ? (extraction.kinds ?? []) : [];
    const standing = extraction.status === 'ok'
      ? extraction.summaries.filter((_, i) => kinds[i] === 'rule' || kinds[i] === 'preference')
      : [];
    if (f.category === 'steerDrop') {
      const mined = standing.filter((s) => /permission|peer/i.test(s));
      record(f.key, mined.length === 0,
        mined.length ? `relayed boilerplate mined as standing: ${mined[0]}` : 'no standing correction mined from relayed content');
    } else {
      const scoped = standing.filter((s) => /ten minutes|10 minutes|continue to the next/i.test(s));
      record(f.key, scoped.length === 0,
        scoped.length ? `session-scoped instruction classified standing: ${scoped[0]}` : `kinds: ${kinds.join(',') || '(none)'}`);
    }
    return;
  }

  const text = preprocessTraceToText([...f.spans], { tokenLimit: 32_000 });
  const fields = await summarizeFacetSpecs(text, BUILTIN_FACET_SPECS, { client, model });
  const task = fields['task']!;
  const issues = fields['issues']!;

  switch (f.category) {
    case 'trivialTask': {
      if (task.status !== 'ok') { record(f.key, false, `task error: ${task.status}`); return; }
      const pass = !isFacetNoneSentinel(task.summary) && !/\/clear|slash command|session (?:clear|reset)/i.test(task.summary);
      record(f.key, pass, `task="${task.summary}"`);
      return;
    }
    case 'noopIssues': {
      if (issues.status !== 'ok') { record(f.key, false, `issues error: ${issues.status}`); return; }
      record(f.key, isFacetNoneSentinel(issues.summary), `issues="${issues.summary}"`);
      return;
    }
    case 'failIssues': {
      if (issues.status !== 'ok') { record(f.key, false, `issues error: ${issues.status}`); return; }
      const pass = !isFacetNoneSentinel(issues.summary) &&
        !/additionally|;\s*also\b/i.test(issues.summary);
      record(f.key, pass, `issues="${issues.summary}"`);
      return;
    }
  }
}

async function main(): Promise<void> {
  for (const fixture of FIXTURES) {
    try {
      await evalFixture(fixture);
    } catch (err) {
      record(fixture.key, false, `harness error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const failed = verdicts.filter((v) => !v.pass);
  console.log(`\n${verdicts.length - failed.length}/${verdicts.length} fixtures passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
