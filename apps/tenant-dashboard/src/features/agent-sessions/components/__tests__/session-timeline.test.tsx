// @vitest-environment jsdom
/**
 * The waterfall math is the contract: rows sort by start time and position on a
 * shared, GAP-COMPRESSED axis (idle stretches capped so a mostly-idle multi-day
 * session doesn't collapse every op into a sliver), tools indent under turns,
 * and errored spans keep their red signal. Each row drills into its I/O, mounted
 * lazily on open. A wrong offset/scale renders a plausible-but-lying waterfall —
 * these pin the numbers.
 */
import { render, screen, within, fireEvent } from '@testing-library/react';

import { SessionTimeline } from '../session-timeline';
import type { AgentSpan } from '../../types';

const span = (over: Partial<AgentSpan>): AgentSpan => ({
  spanId: 's',
  parentSpanId: null,
  name: 'agent.turn.assistant',
  startTime: '2026-07-08T10:00:00.000Z',
  durationMs: 0,
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
  ...over,
});

describe('SessionTimeline', () => {
  it('positions and scales bars on the shared axis, in start order (no idle to compress)', () => {
    // 100s of continuous work: user at t=0 (0s), assistant t=0→60s, tool t=60→100s.
    const spans = [
      span({ spanId: 'tool1', name: 'agent.tool.Bash', startTime: '2026-07-08T10:01:00.000Z', durationMs: 40_000 }),
      span({ spanId: 'u1', name: 'agent.turn.user', startTime: '2026-07-08T10:00:00.000Z', durationMs: 0 }),
      span({ spanId: 'a1', name: 'agent.turn.assistant', startTime: '2026-07-08T10:00:00.000Z', durationMs: 60_000 }),
    ];
    render(<SessionTimeline spans={spans} agentType="claude-code" />);

    // start order, not input order
    const rows = screen.getAllByTestId(/timeline-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'timeline-row-u1',
      'timeline-row-a1',
      'timeline-row-tool1',
    ]);

    // proportional math: assistant = 60% width at 0%; tool = 40% width at 60%
    const bars = screen.getAllByTestId('timeline-bar');
    const a1 = bars[1]!;
    expect(a1.style.left).toBe('0%');
    expect(a1.style.width).toBe('60%');
    const tool = bars[2]!;
    expect(tool.style.left).toBe('60%');
    expect(tool.style.width).toBe('40%');

    // zero-duration spans still render a visible sliver, never disappear
    expect(bars[0]!.style.width).toBe('0.4%');

    // header states the wall clock
    expect(screen.getByText(/1\.7m wall clock · 3 spans/)).toBeInTheDocument();
  });

  it('indents tools and keeps the error signal', () => {
    const spans = [
      span({ spanId: 'a1', name: 'agent.turn.assistant', durationMs: 1000 }),
      span({ spanId: 't1', name: 'agent.tool.Bash', statusCode: '2', startTime: '2026-07-08T10:00:00.500Z', durationMs: 500 }),
    ];
    render(<SessionTimeline spans={spans} agentType="claude-code" />);

    // the tool label renders without the agent.tool. prefix
    expect(screen.getByText('Bash')).toBeInTheDocument();
    // errored span label carries the error color
    expect(screen.getByText('Bash')).toHaveStyle({ color: '#B42318' });
  });

  it('says so when nothing is timed instead of rendering an empty chart', () => {
    render(<SessionTimeline spans={[]} agentType="claude-code" />);
    expect(screen.getByText('No timed spans in this session.')).toBeInTheDocument();
  });

  it('previews what each span did — a turn shows its words, a tool shows its command (not raw JSON)', () => {
    const spans = [
      span({ spanId: 'a1', name: 'agent.turn.assistant', startTime: '2026-07-08T10:00:00.000Z', durationMs: 1000, output: 'Let me look at the issue.' }),
      span({
        spanId: 'b1',
        name: 'agent.tool.Bash',
        startTime: '2026-07-08T10:00:01.000Z',
        durationMs: 21_100,
        input: '{"command":"gh issue view 3498 --json title"}',
        output: 'issue body',
      }),
    ];
    const { container } = render(<SessionTimeline spans={spans} agentType="claude-code" />);

    // previews render in start order [a1, b1]; the tool preview is the unwrapped
    // command, never the raw {"command":…} payload the collapsed row would leak.
    const previews = [...container.querySelectorAll('.tl-preview')].map((n) => n.textContent);
    expect(previews).toEqual(['Let me look at the issue.', 'gh issue view 3498 --json title']);
  });

  it('makes each row a disclosure that drills into the span I/O — mounted only when opened', () => {
    const spans = [
      span({
        spanId: 'b1',
        name: 'agent.tool.Bash',
        durationMs: 21_100,
        input: '{"command":"gh issue view 3498 --json title"}',
        output: 'issue body',
      }),
    ];
    render(<SessionTimeline spans={spans} agentType="claude-code" />);

    const row = screen.getByTestId('timeline-row-b1') as HTMLDetailsElement;
    expect(row.tagName.toLowerCase()).toBe('details');
    expect(row.querySelector('summary')).not.toBeNull();

    // collapsed: the drill-in payload is NOT mounted (a big session has 1000s of
    // rows — we don't pay for every span's I/O text up front)
    expect(row.querySelector('pre')).toBeNull();
    expect(within(row).queryByText('issue body')).toBeNull();

    // open the row (jsdom doesn't toggle <details> on click, so flip it as the
    // browser would and fire the toggle the component listens for)
    row.open = true;
    fireEvent(row, new Event('toggle'));

    // now the raw I/O is shown under labelled blocks — "what actually ate the
    // time" the collapsed label can't answer
    expect(within(row).getByText('input')).toBeInTheDocument();
    expect(within(row).getByText('output')).toBeInTheDocument();
    expect(within(row).getByText('{"command":"gh issue view 3498 --json title"}')).toBeInTheDocument();
    expect(within(row).getByText('issue body')).toBeInTheDocument();
  });

  it('compresses idle gaps so a mostly-idle, days-long session stays readable', () => {
    // A 5s op, then a 1ms op SEVEN DAYS later. On a raw time axis the 5s bar
    // would be 0.0008% — an invisible sliver. Gap compression caps the idle
    // stretch, so the 5s op keeps a real width and the later op sits at the end.
    const spans = [
      span({ spanId: 'slow', name: 'agent.tool.Bash', startTime: '2026-07-08T10:00:00.000Z', durationMs: 5_000, input: '{"command":"build"}' }),
      span({ spanId: 'fast', name: 'agent.tool.Read', startTime: '2026-07-15T10:00:00.000Z', durationMs: 1, metadata: { file: 'a.ts' } }),
    ];
    render(<SessionTimeline spans={spans} agentType="claude-code" />);
    const bars = screen.getAllByTestId('timeline-bar');
    // the slow op is a substantial share of the axis, NOT a sliver
    expect(parseFloat(bars[0]!.style.width)).toBeGreaterThan(30);
    // the later op is positioned near the end — order + timing preserved
    expect(parseFloat(bars[1]!.style.left)).toBeGreaterThan(90);
    // header still tells the truth about the real 7-day wall clock
    expect(screen.getByText(/10080\.0m wall clock/)).toBeInTheDocument();
  });

  it('renders a hook row with its command as the preview and its real duration', () => {
    const spans = [
      span({ spanId: 'hook1', name: 'agent.hook.stop', startTime: '2026-07-08T10:00:00.000Z', durationMs: 13_500, metadata: { hookCommand: './scripts/slow-hook.sh' } }),
    ];
    render(<SessionTimeline spans={spans} agentType="claude-code" />);
    const row = screen.getByTestId('timeline-row-hook1');
    expect(within(row).getByText('stop hook')).toBeInTheDocument();
    expect(within(row).getByText('./scripts/slow-hook.sh')).toBeInTheDocument();
    expect(within(row).getByText('13.5s')).toBeInTheDocument();
  });

  it('shows "—" for a hook that reported no duration, never a fabricated "0ms"', () => {
    const spans = [
      span({
        spanId: 'hook2',
        name: 'agent.hook.stop',
        startTime: '2026-07-08T10:00:00.000Z',
        durationMs: 0,
        metadata: { hookCommand: './scripts/slow-hook.sh', durationUnreported: '1' },
      }),
    ];
    render(<SessionTimeline spans={spans} agentType="claude-code" />);
    const row = screen.getByTestId('timeline-row-hook2');
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).queryByText('0ms')).toBeNull();
  });
});
