// @vitest-environment jsdom
/**
 * Tests: AgentSessionDetail — the turn/tool timeline.
 *
 * Pins the behaviour this session added:
 *   - a spoken turn renders its text; a user turn renders its pasted images as
 *     <img> pointing at the content-addressed blob route, carrying the signed
 *     token that route requires — and says so when that link has expired,
 *   - tool-only assistant turns FOLD under the preceding spoken turn (no extra
 *     header) and their tool rows still render,
 *   - an errored tool surfaces its status message.
 *
 * The component is presentational: it takes the detail payload seeded by the
 * React Server Component (RSC)
 * and `appId` as props (no fetch, no loading/not-found state — the RSC page
 * resolves the data or calls `notFound()` before this ever renders).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useParams: () => ({ orgName: 'acme' }),
}));

import { AgentSessionDetail } from '../agent-session-detail';
import type { AgentSessionDetail as AgentSessionDetailData } from '../../types';

const span = (over: Record<string, unknown>) => ({
  spanId: 's',
  parentSpanId: null,
  name: 'agent.turn.assistant',
  startTime: '2026-01-01T00:00:00Z',
  durationMs: 1,
  statusCode: '1',
  statusMessage: null,
  model: null,
  cost: null,
  inputTokens: null,
  outputTokens: null,
  input: null,
  output: null,
  reasoning: null,
  metadata: {},
  images: [],
  ...over,
});

const DATA: AgentSessionDetailData = {
  session: {
    traceId: 't1',
    sessionId: 't1',
    title: 'Wire the widget',
    agentType: 'claude-code',
    actorId: 'devon',
    workerKind: 'cloud',
    project: 'github.com/agentmark-ai/app',
    startedAt: '2026-01-01T00:00:00Z',
    durationMs: null,
    turnCount: 3,
    toolCallCount: 2,
    errorCount: 1,
    costUsd: 0.08,
    models: ['anthropic/claude-opus-4-8'],
    captureTier: 'full',
    userTurnCount: 3,
    rejectedToolCallCount: 1,
    permissionPromptCount: 4,
    apiErrorCount: 2,
    editRetryLoop: null,
    hookExecutionCount: 0,
    hookDurationMs: 0,
    hookUnreportedCount: 0,
    slowestHookMs: 0,
    slowestHookCommand: '',
  },
  spans: [
    span({
      spanId: 'u1',
      name: 'agent.turn.user',
      input: 'please fix it',
      images: [{ sha256: 'abc123', mediaType: 'image/png', token: 'payload.signature' }],
    }),
    span({ spanId: 'a1', name: 'agent.turn.assistant', output: 'on it', model: 'anthropic/claude-opus-4-8', cost: 0.05 }),
    span({ spanId: 'r1', name: 'agent.tool.Read', parentSpanId: 'a1', output: 'file body', metadata: { file: 'src/x.ts' } }),
    // tool-only assistant turn (no output/reasoning) — folds under a1's block
    span({ spanId: 'a2', name: 'agent.turn.assistant', output: '', cost: 0.03 }),
    span({ spanId: 'b1', name: 'agent.tool.Bash', parentSpanId: 'a2', statusCode: '2', statusMessage: 'command failed', output: 'boom' }),
  ],
  prOutcomes: [],
};

describe('AgentSessionDetail', () => {
  // proves AC-062-07
  it('titles the page with the session and captions it with agent, actor, project and tier', () => {
    const { getByRole, getByTestId } = render(<AgentSessionDetail appId="app-1" data={DATA} />);
    const heading = getByRole('heading', { name: 'Wire the widget' });
    expect(heading.tagName).toBe('H4');
    const header = getByTestId('page-header');
    expect(header).toHaveTextContent('claude-code');
    expect(header).toHaveTextContent('devon · github.com/agentmark-ai/app · tier full');
  });

  it('falls back to a generic title when the session was never named', () => {
    const { getByRole } = render(
      <AgentSessionDetail appId="app-1" data={{ ...DATA, session: { ...DATA.session, title: null } }} />,
    );
    expect(getByRole('heading', { name: 'session' }).tagName).toBe('H4');
  });

  it('renders the transcript: title, turn text, folded tools, error, and image', () => {
    const { container } = render(<AgentSessionDetail appId="app-1" data={DATA} />);
    const text = container.textContent ?? '';

    // header + spoken text
    expect(text).toContain('Wire the widget');
    expect(text).toContain('please fix it');
    expect(text).toContain('on it');

    // both tools render — the Bash tool folded up from the tool-only turn a2
    expect(text).toContain('Read');
    expect(text).toContain('Bash');

    // the errored tool surfaces its message
    expect(text).toContain('command failed');

    // the pasted image renders against the content-addressed blob route,
    // scoped by the appId prop and the URL's orgName (no client app-context
    // read), carrying the signed token the route requires
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(
      '/api/orgs/acme/apps/app-1/agents/blob/abc123?appId=app-1&token=payload.signature',
    );

    // a2 (tool-only) folded → its tool row is present but it added no new header:
    // exactly one <details> tool per rendered tool, both under spoken headers
    expect(container.querySelectorAll('details').length).toBe(2);
  });

  it('explains an image whose signed link expired instead of showing a broken icon', () => {
    const { container } = render(<AgentSessionDetail appId="app-1" data={DATA} />);
    const img = container.querySelector('img');

    // What the browser does when the route rejects an expired token.
    fireEvent.error(img!);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent ?? '').toContain('Image link expired — reload to view');
  });

  it('mounts a tool output only once its row is opened (keeps a big session light)', () => {
    const { container } = render(<AgentSessionDetail appId="app-1" data={DATA} />);

    // collapsed: the output body is NOT in the DOM (the summary/label is, but
    // the multi-KB <pre> text node is not paid for until asked)
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent ?? '').not.toContain('file body');

    // open the first tool row (jsdom doesn't toggle <details> on click, so flip
    // it the way the browser would and fire the toggle the component reads)
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));

    expect(container.querySelector('pre')?.textContent).toContain('file body');
  });

  it('renders the trajectory signal stats: follow-ups (user turns − 1), denials, provider errors, and the shared tool-error rate', () => {
    const { container } = render(<AgentSessionDetail appId="app-1" data={DATA} />);
    const stats = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
    // Each signal renders as value-above-label, adjacent in the stats strip.
    const pairAt = (label: string) => stats[stats.indexOf(label) - 1];
    expect(pairAt('follow-ups')).toBe('2'); // 3 user turns − the initial ask
    expect(pairAt('denials')).toBe('1');
    expect(pairAt('provider errors')).toBe('2');
    expect(pairAt('err rate')).toBe('50%'); // 1 error of 2 tool calls
    // No edit loop on this session → no chip.
    expect(container.querySelector('[data-testid="edit-retry-loop-chip"]')).toBeNull();
  });

  it('renders a slash command as a command line, not as the four XML tags the transcript stores', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      spans: [
        span({
          spanId: 'u1',
          name: 'agent.turn.user',
          input:
            '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
        }),
      ],
    };
    const { container } = render(<AgentSessionDetail appId="app-1" data={data} />);
    const text = container.textContent ?? '';
    expect(text).toContain('/model');
    expect(text).toContain('opus');
    expect(text).not.toContain('<command-name>');
    expect(text).not.toContain('command-args');
    // The command's own restatement of its name adds nothing beside it.
    expect(text).not.toContain('<command-message>');
  });

  it('collapses command output until asked for it', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      spans: [
        span({
          spanId: 'u1',
          name: 'agent.turn.user',
          input: '<command-name>/context</command-name><local-command-stdout>token breakdown here</local-command-stdout>',
        }),
      ],
    };
    const { container, getByText } = render(<AgentSessionDetail appId="app-1" data={data} />);
    expect(container.textContent ?? '').not.toContain('token breakdown here');
    fireEvent.click(getByText('▸ output'));
    expect(container.textContent ?? '').toContain('token breakdown here');
  });

  it('drops a turn that was only the harness caveat boilerplate', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      spans: [
        span({
          spanId: 'u1',
          name: 'agent.turn.user',
          input:
            '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.</local-command-caveat>',
        }),
        span({ spanId: 'u2', name: 'agent.turn.user', input: 'the actual question' }),
      ],
    };
    const { container } = render(<AgentSessionDetail appId="app-1" data={data} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Caveat');
    expect(text).toContain('the actual question');
    // The dropped turn takes its "USER" header with it rather than leaving an
    // empty labelled row.
    expect(Array.from(container.querySelectorAll('p')).filter((p) => p.textContent === 'user')).toHaveLength(1);
  });

  it('does not report a permission-prompt count no adapter can measure', () => {
    // An approved prompt leaves no trace in any transcript, so the stored
    // counter is a structural 0 (or, as here, whatever a producer guessed).
    // Rendering it as a measurement is worse than not rendering it.
    const { container } = render(<AgentSessionDetail appId="app-1" data={DATA} />);
    expect(container.textContent ?? '').not.toContain('permission prompts');
  });

  // proves AC-062-08
  it('renders an unpriced session as "—", never as a confident $0.00', () => {
    // The transcript carries token counts but no cost — a session whose model
    // the price map did not know arrives with no cost at all. A "$0.00" there
    // reads as "this run was free" and silently deflates every cost rollup.
    const data: AgentSessionDetailData = {
      ...DATA,
      session: { ...DATA.session, costUsd: null },
    };
    const { container } = render(<AgentSessionDetail appId="app-1" data={data} />);
    const stats = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
    expect(stats[stats.indexOf('cost') - 1]).toBe('—');
  });

  // proves AC-062-09
  it('surfaces an edit loop as a warning chip naming the file and run length', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      session: { ...DATA.session, editRetryLoop: { file: 'src/deep/path/broken.ts', fails: 5 } },
    };
    const { container } = render(<AgentSessionDetail appId="app-1" data={data} />);
    const chip = container.querySelector('[data-testid="edit-retry-loop-chip"]');
    expect(chip?.textContent).toBe('edit loop · 5× on broken.ts');
  });

  // proves AC-062-10
  it('renders the PR-outcome strip per PR, and hides it entirely when the session touched no scored PR', () => {
    // No scored PR → no strip at all (most sessions), not an empty header.
    const { container: bare } = render(<AgentSessionDetail appId="app-1" data={{ ...DATA, prOutcomes: [] }} />);
    expect(bare.textContent ?? '').not.toContain('pr outcomes');

    // Two PRs with DIFFERENT fates on the same session → two labelled rows, not
    // one collapsed line. Each score renders its own honest chip. (prOutcomes
    // rides the session payload — no separate fetch.)
    const data: AgentSessionDetailData = {
      ...DATA,
      prOutcomes: [
        { prNumber: 21, prUrl: 'https://github.com/acme/app/pull/21', ciGreen: { score: 1, label: 'success' }, merged: { score: 1, label: 'merged' }, reverted: { score: 0, label: 'standing' } },
        { prNumber: 22, prUrl: null, ciGreen: { score: 0, label: 'failure' }, merged: { score: 0, label: 'closed' }, reverted: null },
        { prNumber: 23, prUrl: 'https://github.com/acme/app/pull/23', ciGreen: { score: 1, label: 'success' }, merged: { score: 1, label: 'merged' }, reverted: { score: 1, label: 'reverted' } },
      ],
    };
    const { container, getByText } = render(<AgentSessionDetail appId="app-1" data={data} />);
    const text = container.textContent ?? '';

    expect(text).toContain('pr outcomes');
    expect(text).toContain('PR #21');
    expect(text).toContain('PR #22');
    // PR 21 has a url → links out; PR 22 has none → plain text.
    expect(getByText('PR #21').closest('a')).toHaveAttribute('href', 'https://github.com/acme/app/pull/21');
    expect(getByText('PR #22').closest('a')).toBeNull();
    // PR 21: passed CI first try, merged, NOT reverted.
    expect(text).toContain('CI passed first try');
    expect(text).toContain('Merged');
    // PR 22: failed first CI, closed unmerged — distinct from PR 21, proving
    // the two PRs are NOT collapsed into one ambiguous row.
    expect(text).toContain('CI failed first try');
    expect(text).toContain('Closed unmerged');
    // A merged-and-standing PR shows NO durability chip — "held" is the
    // expected case, so only a real revert (PR 23) surfaces one.
    expect(text).not.toContain('Standing');
    expect(text).toContain('Reverted');
  });

  it('shows the honesty caption even at zero hook runs — an empty count is not "no hooks ran"', () => {
    const { getByTestId } = render(<AgentSessionDetail appId="app-1" data={DATA} />);
    expect(getByTestId('hook-rollup')).toHaveTextContent('hooks: 0 runs');
    expect(getByTestId('hook-caption')).toHaveTextContent(
      'Stop hooks only. The agent transcript does not record PreToolUse/PostToolUse hook timing; an empty list does not mean no hooks ran.',
    );
  });

  it('hides the caption once the session carries a wrapped Pre/PostToolUse hook span — the disclaimer would be false for it', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      spans: [...DATA.spans, span({ spanId: 'h1', name: 'agent.hook.pre_tool_use', parentSpanId: 'r1' })],
    };
    const { queryByTestId } = render(<AgentSessionDetail appId="app-1" data={data} />);
    expect(queryByTestId('hook-caption')).toBeNull();
  });

  it('a session with only agent.hook.stop spans (no wrapped hooks) still shows the caption', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      spans: [...DATA.spans, span({ spanId: 'h2', name: 'agent.hook.stop' })],
    };
    const { getByTestId } = render(<AgentSessionDetail appId="app-1" data={data} />);
    expect(getByTestId('hook-caption')).toBeInTheDocument();
  });

  it('renders the hook rollup line with total time (marked partial), and the slowest command', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      session: {
        ...DATA.session,
        hookExecutionCount: 12,
        hookDurationMs: 4200,
        hookUnreportedCount: 3,
        slowestHookMs: 13_500,
        slowestHookCommand: './scripts/slow-hook.sh',
      },
    };
    const { getByTestId } = render(<AgentSessionDetail appId="app-1" data={data} />);
    // 3 of 12 didn't report a duration, so the total must say "(9 timed)" —
    // silently implying full coverage would misstate what the sum covers.
    expect(getByTestId('hook-rollup')).toHaveTextContent(
      'hooks: 12 runs · 4.2s total (9 timed) · slowest: ./scripts/slow-hook.sh 13.5s',
    );
  });

  it('never renders a fabricated "0ms total" when every hook is unreported', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      session: {
        ...DATA.session,
        hookExecutionCount: 3,
        hookDurationMs: 0,
        hookUnreportedCount: 3,
        slowestHookMs: 0,
        slowestHookCommand: '',
      },
    };
    const { getByTestId } = render(<AgentSessionDetail appId="app-1" data={data} />);
    expect(getByTestId('hook-rollup')).toHaveTextContent('hooks: 3 runs · no timing reported');
    expect(getByTestId('hook-rollup')).not.toHaveTextContent('0ms');
  });

  it('never drops a real slowest duration just because the slowest command string is empty', () => {
    const data: AgentSessionDetailData = {
      ...DATA,
      session: {
        ...DATA.session,
        hookExecutionCount: 2,
        hookDurationMs: 13_700,
        hookUnreportedCount: 0,
        slowestHookMs: 13_500,
        slowestHookCommand: '',
      },
    };
    const { getByTestId } = render(<AgentSessionDetail appId="app-1" data={data} />);
    expect(getByTestId('hook-rollup')).toHaveTextContent('hooks: 2 runs · 13.7s total · slowest: (unknown command) 13.5s');
  });
});
