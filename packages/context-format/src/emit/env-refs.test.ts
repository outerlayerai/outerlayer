import { describe, expect, it } from 'vitest';
import { cursorEnvRefRewrite, findEnvRefs, rewriteEnvRefs } from './env-refs';

describe('findEnvRefs', () => {
  it('finds a plain ${VAR} reference with no default', () => {
    expect(findEnvRefs('${API_TOKEN}')).toEqual([{ raw: '${API_TOKEN}', varName: 'API_TOKEN', defaultValue: null }]);
  });

  it('finds a ${VAR:-default} reference and captures the default', () => {
    expect(findEnvRefs('${API_URL:-https://api.example.com}')).toEqual([
      { raw: '${API_URL:-https://api.example.com}', varName: 'API_URL', defaultValue: 'https://api.example.com' },
    ]);
  });

  it('finds multiple references in one string, in order', () => {
    expect(findEnvRefs('Bearer ${TOKEN} for ${HOST:-localhost}')).toEqual([
      { raw: '${TOKEN}', varName: 'TOKEN', defaultValue: null },
      { raw: '${HOST:-localhost}', varName: 'HOST', defaultValue: 'localhost' },
    ]);
  });

  it('returns an empty array when there are no references', () => {
    expect(findEnvRefs('https://api.example.com')).toEqual([]);
  });

  it('does not leak lastIndex state across separate calls (fresh RegExp per call)', () => {
    expect(findEnvRefs('${A}')).toEqual([{ raw: '${A}', varName: 'A', defaultValue: null }]);
    expect(findEnvRefs('${B}')).toEqual([{ raw: '${B}', varName: 'B', defaultValue: null }]);
  });
});

describe('rewriteEnvRefs', () => {
  it('rewrites every match via the supplied fn and collects warnings in order', () => {
    const result = rewriteEnvRefs('${A} and ${B:-x}', (ref) =>
      ref.defaultValue !== null ? { text: `<${ref.varName}>`, warning: `dropped default for ${ref.varName}` } : { text: `<${ref.varName}>` },
    );

    expect(result.value).toBe('<A> and <B>');
    expect(result.warnings).toEqual(['dropped default for B']);
  });

  it('leaves the string untouched and returns no warnings when there are no references', () => {
    const result = rewriteEnvRefs('plain text', () => ({ text: 'unused' }));

    expect(result.value).toBe('plain text');
    expect(result.warnings).toEqual([]);
  });
});

describe('cursorEnvRefRewrite', () => {
  it('rewrites ${VAR} to ${env:VAR} with no warning', () => {
    expect(cursorEnvRefRewrite({ raw: '${API_TOKEN}', varName: 'API_TOKEN', defaultValue: null })).toEqual({
      text: '${env:API_TOKEN}',
    });
  });

  it('rewrites ${VAR:-default} to ${env:VAR}, dropping the default, with a warning naming the dropped value', () => {
    expect(cursorEnvRefRewrite({ raw: '${API_URL:-https://x}', varName: 'API_URL', defaultValue: 'https://x' })).toEqual({
      text: '${env:API_URL}',
      warning: '"${API_URL:-https://x}" has no Cursor default-value equivalent — emitted as "${env:API_URL}", default dropped',
    });
  });
});
