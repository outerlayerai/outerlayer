// @vitest-environment jsdom
/**
 * useGenerateTopics — the generate/regenerate action wiring for the Topics
 * card. The topic map read is a React Server Component (RSC) concern (seeded as a prop); this hook
 * owns only the ephemeral state around triggering a generation: whether one
 * is in flight and the last outcome the action returned.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useGenerateTopics } from './use-topics';
import { generateTopics } from '../actions';

vi.mock('../actions', () => ({ generateTopics: vi.fn() }));

const mockGenerateTopics = vi.mocked(generateTopics);

beforeEach(() => {
  mockGenerateTopics.mockReset();
});

describe('useGenerateTopics', () => {
  it('calls the action with appId + facet and stores a successful outcome', async () => {
    const outcome = { status: 'generated' as const, facet: 'task' as const, mapVersion: 3, topicCount: 5, sampleSize: 120, noiseCount: 4, mode: 'live', generationMs: 900 };
    mockGenerateTopics.mockResolvedValue({ ok: true, data: outcome });

    const { result } = renderHook(() => useGenerateTopics('app-1', 'task'));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.generate();
    });

    expect(mockGenerateTopics).toHaveBeenCalledWith({ appId: 'app-1', facet: 'task' });
    expect(returned).toEqual(outcome);
    expect(result.current.lastOutcome).toEqual(outcome);
    expect(result.current.generating).toBe(false);
  });

  it('is generating while the action is in flight', async () => {
    let resolveAction: (value: Awaited<ReturnType<typeof generateTopics>>) => void;
    mockGenerateTopics.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );

    const { result } = renderHook(() => useGenerateTopics('app-1', 'steering'));

    let generatePromise: Promise<unknown>;
    act(() => {
      generatePromise = result.current.generate();
    });
    await waitFor(() => expect(result.current.generating).toBe(true));

    await act(async () => {
      resolveAction!({ ok: true, data: { status: 'not_enough_data', facet: 'steering', sampleSize: 1, required: 100 } });
      await generatePromise;
    });

    expect(result.current.generating).toBe(false);
  });

  it('throws the action error message and clears `generating`, without setting an outcome', async () => {
    mockGenerateTopics.mockResolvedValue({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Temporary access is read-only and cannot generate topics.' },
    });

    const { result } = renderHook(() => useGenerateTopics('app-1', 'task'));

    await act(async () => {
      await expect(result.current.generate()).rejects.toThrow(
        'Temporary access is read-only and cannot generate topics.',
      );
    });

    expect(result.current.generating).toBe(false);
    expect(result.current.lastOutcome).toBeNull();
  });
});
