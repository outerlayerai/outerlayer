// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import usePopover from './use-popover';

// ----------------------------------------------------------------------

describe('usePopover', () => {
  it('starts closed with open === null', () => {
    const { result } = renderHook(() => usePopover());
    expect(result.current.open).toBeNull();
  });

  it('onOpen stores event.currentTarget as the anchor', () => {
    const { result } = renderHook(() => usePopover());
    const anchor = document.createElement('button');

    act(() => {
      result.current.onOpen({ currentTarget: anchor } as unknown as React.MouseEvent<HTMLElement>);
    });

    // Exact instance — the anchor doubles as anchorEl in CustomPopover.
    expect(result.current.open).toBe(anchor);
  });

  it('onClose nulls the anchor', () => {
    const { result } = renderHook(() => usePopover());
    const anchor = document.createElement('button');

    act(() => {
      result.current.onOpen({ currentTarget: anchor } as unknown as React.MouseEvent<HTMLElement>);
    });
    expect(result.current.open).toBe(anchor);

    act(() => {
      result.current.onClose();
    });
    expect(result.current.open).toBeNull();
  });

  it('exposes the raw setOpen setter', () => {
    const { result } = renderHook(() => usePopover());
    const anchor = document.createElement('div');

    act(() => {
      result.current.setOpen(anchor);
    });

    expect(result.current.open).toBe(anchor);
  });
});
