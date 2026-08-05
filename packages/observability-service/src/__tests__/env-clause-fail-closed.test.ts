import { describe, expect, it } from 'vitest';

import { buildEnvironmentWhereClause } from '../shared';

/**
 * `environments: []` and `environments: undefined` mean opposite things — "may
 * read no environment" versus "no env filter" — and collapsing them into the
 * same empty clause widens the read to everything. The empty case is reachable:
 * a kind-scoped API key whose allowed kinds match none of the app's
 * environments resolves to exactly it.
 */
describe('buildEnvironmentWhereClause fail-closed semantics', () => {
  it('emits a false predicate for an explicitly EMPTY allow-list', () => {
    expect(buildEnvironmentWhereClause('Environment', { environments: [] })).toEqual({
      clause: 'AND 1 = 0',
      params: {},
    });
  });

  it('emits no clause only when no scope was requested at all', () => {
    expect(buildEnvironmentWhereClause('Environment', {})).toEqual({ clause: '', params: {} });
  });

  it('binds a non-empty allow-list as a parameterised IN', () => {
    expect(
      buildEnvironmentWhereClause('Environment', { environments: ['pr-42', 'prod'] }),
    ).toEqual({
      clause: 'AND Environment IN ({envNames:Array(String)})',
      params: { envNames: ['pr-42', 'prod'] },
    });
  });

  it('still handles the single-env forms, default and non-default', () => {
    expect(
      buildEnvironmentWhereClause('Environment', {
        environment: { name: 'dev', isDefault: true },
      }),
    ).toEqual({
      clause: "AND (Environment = {envName:String} OR Environment = '')",
      params: { envName: 'dev' },
    });
    expect(
      buildEnvironmentWhereClause('Environment', {
        environment: { name: 'prod', isDefault: false },
      }),
    ).toEqual({
      clause: 'AND Environment = {envName:String}',
      params: { envName: 'prod' },
    });
  });
});
