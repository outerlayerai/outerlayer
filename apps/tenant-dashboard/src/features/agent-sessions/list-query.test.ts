/**
 * `parseSessionsUrlParams` — the one place the sessions-list URL's UI keys
 * (agent/developer/source, a 0-based `page`) translate into the service's
 * `ListSessionsQuery` shape (agentType/actor/workerKind, an offset). Pins
 * the field-name/defaulting rules a mismatch between this parser and the
 * client's URL vocabulary would silently drop, plus the general per-field
 * salvage behavior any future field benefits from.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionsUrlParams, SESSIONS_PAGE_SIZE } from './list-query';

describe('parseSessionsUrlParams', () => {
  it('maps the UI filter-bar keys to their service field names (agent/developer/source)', () => {
    const query = parseSessionsUrlParams(
      { agent: 'claude-code', developer: 'mem-123', source: 'seat' },
      false,
    );
    expect(query).toMatchObject({ agentType: 'claude-code', actor: 'mem-123', workerKind: 'seat' });
    // The raw UI keys must never leak into the query as unknown fields.
    expect(query).not.toHaveProperty('agent');
    expect(query).not.toHaveProperty('developer');
    expect(query).not.toHaveProperty('source');
  });

  it('maps a 0-based page to an offset of page * SESSIONS_PAGE_SIZE', () => {
    expect(parseSessionsUrlParams({ page: '0' }, false).offset).toBe(0);
    expect(parseSessionsUrlParams({ page: '3' }, false).offset).toBe(3 * SESSIONS_PAGE_SIZE);
    // A garbage page value falls back to page 0, not a NaN offset.
    expect(parseSessionsUrlParams({ page: 'not-a-number' }, false).offset).toBe(0);
  });

  it('defaults an absent origin to the People segment (interactive,worker) outside a topic drill-down', () => {
    const query = parseSessionsUrlParams({}, false);
    expect(query.origin).toBe('interactive,worker');
  });

  it('defaults an absent origin to every-origin (undefined) inside a topic drill-down', () => {
    const query = parseSessionsUrlParams({ topicId: 't1', topicFacet: 'task' }, true);
    expect(query.origin).toBeUndefined();
  });

  // `?origin=` tokens select the SQL literals spliced into `Origin IN (...)`,
  // so only tokens the map owns are valid. An inherited key must fall back to
  // the default segment, exactly like any other invalid value.
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "treats the inherited origin token %s as invalid and falls back to the default segment",
    (inherited) => {
      expect(parseSessionsUrlParams({ origin: inherited }, false).origin).toBe(
        "interactive,worker",
      );
      // ...including when it hides among valid tokens.
      expect(
        parseSessionsUrlParams({ origin: `agent,${inherited}` }, false).origin,
      ).toBe("interactive,worker");
    },
  );

  it('maps the explicit "all" origin choice to every-origin (undefined), never a literal the schema rejects', () => {
    const query = parseSessionsUrlParams({ origin: 'all' }, false);
    expect(query.origin).toBeUndefined();
  });

  it('passes an explicit, valid origin token straight through', () => {
    expect(parseSessionsUrlParams({ origin: 'agent' }, false).origin).toBe('agent');
  });

  it('salvages every other field when one field is invalid, instead of falling back to an all-defaults query', () => {
    const query = parseSessionsUrlParams(
      { agent: 'claude-code', branch: 'main', sort: 'not-a-real-sort-column' },
      false,
    );
    // The one bad field (sort) is dropped to its schema default...
    expect(query.sort).toBe('startedAt');
    // ...but the two valid fields sent alongside it survive.
    expect(query.agentType).toBe('claude-code');
    expect(query.branch).toBe('main');
  });

  it('falls back a malformed/unrecognized origin token to the People default, mirroring the client\'s asOrigin — never salvage-drops it to every-origin', () => {
    const query = parseSessionsUrlParams({ origin: 'garbage', q: 'timeout' }, false);
    expect(query.origin).toBe('interactive,worker');
    // The other, valid field sent alongside it still survives.
    expect(query.q).toBe('timeout');
  });

  it('falls back a malformed origin token to every-origin inside a topic drill-down (the drill-down default, not the People segment)', () => {
    const query = parseSessionsUrlParams({ origin: 'garbage', topicId: 't1', topicFacet: 'task' }, true);
    expect(query.origin).toBeUndefined();
  });

  it('passes q, branch, model, signal, sort, dir straight through unchanged', () => {
    const query = parseSessionsUrlParams(
      { q: 'timeout', branch: 'main', model: 'claude-4', signal: 'denied', sort: 'cost', dir: 'asc' },
      false,
    );
    expect(query).toMatchObject({
      q: 'timeout',
      branch: 'main',
      model: 'claude-4',
      signal: 'denied',
      sort: 'cost',
      dir: 'asc',
    });
  });

  it('always pins limit to SESSIONS_PAGE_SIZE — the URL never gets to set its own page size', () => {
    expect(parseSessionsUrlParams({}, false).limit).toBe(SESSIONS_PAGE_SIZE);
  });

  it('drops an invalid dir token to its default (desc), never passing a bad value through', () => {
    const query = parseSessionsUrlParams({ dir: 'sideways' }, false);
    expect(query.dir).toBe('desc');
  });

  it('drops a q longer than 200 chars, not a truncated or silently-passed value', () => {
    const tooLong = 'x'.repeat(201);
    const query = parseSessionsUrlParams({ q: tooLong }, false);
    expect(query.q).toBeUndefined();
  });

  it('passes a q at exactly the 200-char boundary through unchanged', () => {
    const atLimit = 'x'.repeat(200);
    const query = parseSessionsUrlParams({ q: atLimit }, false);
    expect(query.q).toBe(atLimit);
  });

  it('drops a malformed from/to instant, never forwarding an unparseable date string', () => {
    const query = parseSessionsUrlParams({ from: 'not-a-date', to: '2026-01-01T00:00:00Z' }, false);
    expect(query.from).toBeUndefined();
    expect(query.to).toBe('2026-01-01T00:00:00Z');
  });

  it('drops an invalid topicFacet token instead of passing it through', () => {
    const query = parseSessionsUrlParams({ topicId: 't1', topicFacet: 'not-a-facet' }, false);
    expect(query.topicFacet).toBeUndefined();
    // topicId itself is a free string — it still survives the salvage.
    expect(query.topicId).toBe('t1');
  });

  it('passes includeSubagents=1 through, and drops any other value', () => {
    expect(parseSessionsUrlParams({ includeSubagents: '1' }, false).includeSubagents).toBe('1');
    expect(parseSessionsUrlParams({ includeSubagents: 'true' }, false).includeSubagents).toBeUndefined();
  });
});
