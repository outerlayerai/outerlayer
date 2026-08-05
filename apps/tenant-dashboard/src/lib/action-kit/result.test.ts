import { describe, it, expect } from 'vitest';

import { ok, fail } from './result';

describe('result helpers', () => {
  it('ok wraps a value in an exact success shape', () => {
    expect(ok({ id: 'k1' })).toStrictEqual({ ok: true, data: { id: 'k1' } });
  });

  it('fail wraps an error in an exact failure shape, preserving fieldErrors', () => {
    expect(
      fail({
        code: 'validation_error',
        message: 'bad',
        fieldErrors: { name: ['required'] },
      }),
    ).toStrictEqual({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'bad',
        fieldErrors: { name: ['required'] },
      },
    });
  });
});
