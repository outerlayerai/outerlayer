/**
 * Tests: agent-format — the shared formatters for the Agents sections.
 *
 * Pure functions; each assertion pins a concrete output including the edge
 * cases that a mutation would slip through (null → em-dash, the k/M/B compact
 * thresholds, the zero-prior delta branch, the "last two segments" project
 * shortening, and the color fallbacks).
 */

import { describe, it, expect } from 'vitest';

import {
  money,
  compactNum,
  pct,
  deltaOf,
  shortModel,
  shortProject,
  agentColor,
  SEVERITY_COLOR,
} from '../agent-format';

describe('money', () => {
  it('formats to two decimals with a $ prefix', () => {
    expect(money(0)).toBe('$0.00');
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(0.1)).toBe('$0.10');
  });
  it('renders null/undefined as an em-dash', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
  });
});

describe('compactNum', () => {
  it('abbreviates at the k/M/B thresholds', () => {
    expect(compactNum(999)).toBe('999');
    expect(compactNum(1_000)).toBe('1.0k');
    expect(compactNum(2_500_000)).toBe('2.5M');
    expect(compactNum(3_200_000_000)).toBe('3.2B');
  });
  it('renders null as an em-dash', () => {
    expect(compactNum(null)).toBe('—');
  });
});

describe('pct', () => {
  it('multiplies by 100 with one decimal and a % suffix', () => {
    expect(pct(0.1234)).toBe('12.3%');
    expect(pct(0)).toBe('0.0%');
  });
  it('renders null as an em-dash', () => {
    expect(pct(null)).toBe('—');
  });
});

describe('deltaOf', () => {
  it('labels a zero-prior as "new" when current is non-zero, "—" when zero', () => {
    expect(deltaOf(5, 0)).toEqual({ text: 'new', dir: 'up' });
    expect(deltaOf(0, 0)).toEqual({ text: '—', dir: 'flat' });
  });
  it('treats a sub-0.5% move as flat', () => {
    expect(deltaOf(1000, 1000)).toEqual({ text: '±0%', dir: 'flat' });
  });
  it('signs an increase and a decrease', () => {
    expect(deltaOf(150, 100)).toEqual({ text: '+50%', dir: 'up' });
    expect(deltaOf(80, 100)).toEqual({ text: '-20%', dir: 'down' });
  });
});

describe('shortModel', () => {
  it('strips a provider prefix', () => {
    expect(shortModel('anthropic/claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(shortModel('gpt-5')).toBe('gpt-5');
  });
});

describe('shortProject', () => {
  it('keeps the last two path segments', () => {
    expect(shortProject('github.com/agentmark-ai/app')).toBe('agentmark-ai/app');
  });
  it('returns a bare name unchanged and a placeholder for empty', () => {
    expect(shortProject('app')).toBe('app');
    expect(shortProject(null)).toBe('(no project)');
    expect(shortProject('')).toBe('(no project)');
  });
});

describe('agentColor / SEVERITY_COLOR', () => {
  it('maps known agents; unknown agents get deterministic, distinct fallbacks', () => {
    expect(agentColor('claude-code')).toBe('#2065D1');
    expect(agentColor('codex')).toBe('#1E7F4F');
    expect(agentColor('cursor')).toBe('#7A5EA8');
    // Open agent set: unknown types must render a real color, stably. Exact
    // hex pins kill hash-arithmetic mutants — any change to the loop or
    // modulo remaps these inputs to different palette slots.
    expect(agentColor('gemini-cli')).toBe('#B54708');
    expect(agentColor('aider')).toBe('#0E7490');
    expect(agentColor('opencode')).toBe('#4D7C0F');
    // ...and never one of the reserved brand colors.
    expect(['#2065D1', '#1E7F4F', '#7A5EA8']).not.toContain(agentColor('gemini-cli'));
  });
  it('exposes the severity palette', () => {
    expect(SEVERITY_COLOR.high).toBe('#B42318');
    expect(SEVERITY_COLOR.warn).toBe('#B54708');
    expect(SEVERITY_COLOR.info).toBe('#5B6169');
  });
});
