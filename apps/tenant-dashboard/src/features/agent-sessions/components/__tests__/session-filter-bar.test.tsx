// @vitest-environment jsdom
/**
 * The converged filter bar: one `+ Filter` idiom over DATA-driven dimensions,
 * active filters as removable tokens, value-labeled time picker. These pin
 * the contract that matters:
 *   - the picker's vocabulary comes from props (the server facets), never a
 *     baked-in enum — an agent the UI has never seen is offered and pickable;
 *   - picking emits the next ActiveFilters; × removes exactly one; Clear all
 *     empties;
 *   - typeahead narrows across dimension names AND values.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('@/components/iconify', () => ({
  __esModule: true,
  // Pass everything through — the delete affordance rides aria-label + onClick.
  default: ({ icon, sx: _sx, ...rest }: { icon: string; sx?: unknown } & Record<string, unknown>) => (
    <span data-testid={`icon-${icon}`} {...rest} />
  ),
}));

import { SessionFilterBar, type FilterDimension } from '../session-filter-bar';

const DIMENSIONS: FilterDimension[] = [
  { key: 'agent', label: 'Agent', values: ['claude-code', 'gemini-cli'] },
  { key: 'branch', label: 'Branch', values: ['main', 'fix/dependabot-topics'] },
  { key: 'developer', label: 'Developer', values: ['67665041-4960-421d-8254-a825840dd74b'] },
];

function setup(over: Partial<Parameters<typeof SessionFilterBar>[0]> = {}) {
  const onChange = vi.fn();
  const onSearch = vi.fn();
  const onRange = vi.fn();
  const onOrigin = vi.fn();
  const onSaveView = vi.fn();
  const onApplyView = vi.fn();
  const onDeleteView = vi.fn();
  render(
    <SessionFilterBar
      search=""
      onSearch={onSearch}
      range=""
      onRange={onRange}
      origin=""
      onOrigin={onOrigin}
      dimensions={DIMENSIONS}
      active={{}}
      onChange={onChange}
      views={[]}
      canSaveView={false}
      onSaveView={onSaveView}
      onApplyView={onApplyView}
      onDeleteView={onDeleteView}
      {...over}
    />,
  );
  return { onChange, onSearch, onRange, onOrigin, onSaveView, onApplyView, onDeleteView };
}

describe('SessionFilterBar', () => {
  it('offers every dimension value from props — including agents no enum knows', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));

    // dimension group headers
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Branch')).toBeInTheDocument();
    expect(screen.getByText('Developer')).toBeInTheDocument();
    // the unknown-to-the-UI agent is offered
    expect(screen.getByText('gemini-cli')).toBeInTheDocument();
    // long opaque ids display shortened
    expect(screen.getByText('67665041…d74b')).toBeInTheDocument();
  });

  it('picking a value emits it for the right dimension', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByText('gemini-cli'));
    expect(onChange).toHaveBeenCalledWith({ agent: 'gemini-cli' });
  });

  it('typeahead narrows by value and by dimension name', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    const input = screen.getByPlaceholderText('Filter by…');

    fireEvent.change(input, { target: { value: 'gemini' } });
    expect(screen.getByText('gemini-cli')).toBeInTheDocument();
    expect(screen.queryByText('main')).not.toBeInTheDocument();

    // dimension-name match keeps the whole group
    fireEvent.change(input, { target: { value: 'branch' } });
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.queryByText('gemini-cli')).not.toBeInTheDocument();
  });

  it('renders active filters as tokens; × removes exactly that one', () => {
    const { onChange } = setup({ active: { agent: 'gemini-cli', branch: 'main' } });

    expect(screen.getByText('agent: gemini-cli')).toBeInTheDocument();
    expect(screen.getByText('branch: main')).toBeInTheDocument();

    const agentToken = screen.getByText('agent: gemini-cli').closest('.MuiChip-root')!;
    fireEvent.click(agentToken.querySelector('.MuiChip-deleteIcon')!);
    expect(onChange).toHaveBeenCalledWith({ agent: undefined, branch: 'main' });
  });

  it('Clear all empties the set and only shows when something is active', () => {
    const { onChange } = setup({ active: { branch: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('hides Clear all when nothing is active', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('the time picker labels itself with the selected VALUE', () => {
    setup({ range: '7d' });
    expect(screen.getByText('Last 7 days')).toBeInTheDocument();
  });

  it('the origin segments mark the active one and emit the API key on click', () => {
    const { onOrigin } = setup({ origin: 'agent' });
    expect(screen.getByRole('button', { name: 'Agents' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'People' })).toHaveAttribute('aria-pressed', 'false');
    // People = interactive AND worker runs — one comma-set API value.
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    expect(onOrigin).toHaveBeenCalledWith('interactive,worker');
    // The All segment emits "" — the every-origin API value.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onOrigin).toHaveBeenCalledWith('');
  });

  it('re-clicking the active segment emits nothing — one segment is always on', () => {
    const { onOrigin } = setup({ origin: 'interactive,worker' });
    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    expect(onOrigin).not.toHaveBeenCalled();
  });

  it('segment labels carry the per-origin counts when provided; People sums interactive+worker, All sums every origin', () => {
    setup({ origin: 'interactive,worker', originCounts: { interactive: 1200, agent: 34, worker: 5 } });
    expect(screen.getByRole('button', { name: 'People' })).toHaveTextContent('People (1,205)');
    expect(screen.getByRole('button', { name: 'Agents' })).toHaveTextContent('Agents (34)');
    expect(screen.getByRole('button', { name: 'All' })).toHaveTextContent('All (1,239)');
  });

  /* The bar renders during SSR from facet counts seeded by a React Server
   * Component (RSC), so a
   * formatter reading the ambient locale groups one way on the server and
   * another in the browser. The stub stands in for a visitor whose separator
   * differs; the "1,205" assertion above would pass under the ambient en-US
   * formatter too, so it cannot catch this on its own. */
  it('groups the segment counts without consulting the ambient locale', () => {
    const ambient = vi
      .spyOn(Number.prototype, 'toLocaleString')
      .mockReturnValue('AMBIENT_LOCALE');

    setup({ origin: 'interactive,worker', originCounts: { interactive: 1234567, agent: 34, worker: 5 } });

    expect(screen.getByRole('button', { name: 'People' })).toHaveTextContent('People (1,234,572)');
    expect(screen.getByRole('button', { name: 'Agents' })).toHaveTextContent('Agents (34)');

    ambient.mockRestore();
  });
});

describe('SessionFilterBar — saved views', () => {
  it('lists saved views; clicking applies; × deletes without applying', () => {
    const { onApplyView, onDeleteView } = setup({
      views: [
        { id: 'v1', name: 'Gemini last 7d' },
        { id: 'v2', name: 'Costly failures' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /views/i }));
    fireEvent.click(screen.getByText('Costly failures'));
    expect(onApplyView).toHaveBeenCalledWith('v2');
    expect(onDeleteView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /views/i }));
    fireEvent.click(screen.getByLabelText('Delete view Gemini last 7d'));
    expect(onDeleteView).toHaveBeenCalledWith('v1');
    expect(onApplyView).toHaveBeenCalledTimes(1);
  });

  it('Save view only offers itself when there is something to save, and submits the typed name', () => {
    const { onSaveView, rerender } = (() => {
      const r = setup({ canSaveView: false });
      return { ...r, rerender: null };
    })();
    expect(screen.queryByRole('button', { name: /save view/i })).not.toBeInTheDocument();
    void rerender;

    // fresh render with an active filter state
    document.body.innerHTML = '';
    const second = setup({ canSaveView: true });
    fireEvent.click(screen.getByRole('button', { name: /save view/i }));
    fireEvent.change(screen.getByPlaceholderText('View name…'), { target: { value: 'Gemini last 7d' } });
    fireEvent.keyDown(screen.getByPlaceholderText('View name…'), { key: 'Enter' });
    expect(second.onSaveView).toHaveBeenCalledWith('Gemini last 7d');
    expect(onSaveView).not.toHaveBeenCalled();
  });

  it('hides the Views button when none are saved', () => {
    setup({ views: [] });
    expect(screen.queryByRole('button', { name: /views/i })).not.toBeInTheDocument();
  });
});
