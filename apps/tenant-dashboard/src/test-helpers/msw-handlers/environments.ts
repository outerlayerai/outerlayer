/**
 * MSW handlers for the gateway `/v1/environments` routes.
 *
 * Unlike the other handlers in this directory (which back Supabase REST
 * tables on `http://localhost:54321`), environments are read straight off the
 * AgentMark gateway. The `useEnvironments` SWR hook calls
 * `listEnvironments(appId)` (the typed gateway client in `@/lib/api/gateway-client`),
 * which requests `${GATEWAY_URL}/v1/...` where `GATEWAY_URL` comes from `@/config-global`.
 *
 * To keep the handler's URL prefix locked to whatever the test runtime uses,
 * we import `GATEWAY_URL` from the same module the production code reads
 * (`@/config-global`). Under test, `unit-test-setup.ts` mocks that module to
 * `http://localhost:9100`; in production it resolves from
 * `env.NEXT_PUBLIC_GATEWAY_URL`. Either way, handler and code-under-test stay
 * pinned to the same origin and can never drift.
 *
 * The GET route returns the canonical envelope `{ data: Environment[],
 * pagination }`. `useEnvironments` double-unwraps to
 * `Environment[]`.
 *
 * The POST route (`useCreateEnvironment`) creates a non-default env. The
 * handler appends the new env to that app's GET list so a subsequent
 * revalidation surfaces it — letting tests assert the create→list-refresh
 * wiring without hand-rolling Supabase internals.
 *
 * State is per-test: reset via {@link resetEnvironmentsMswState}, seed via
 * {@link seedEnvironmentsMswState}. Tests declare the env list as data — they
 * never hand-roll a fetch mock.
 */

import { http, HttpResponse } from 'msw';

import { GATEWAY_URL } from '@/config-global';
import type { Environment, EnvironmentDetail } from '@/types/environment';

/**
 * Env list keyed by the `X-Outerlayer-App-Id` header the gateway scopes on.
 * A request whose app id has no entry gets an empty list (the realistic
 * "app has no envs yet" response, before the default-env seed lands).
 */
type EnvironmentsMswState = {
  environmentsByAppId: Record<string, Environment[]>;
  /** Detail rows keyed by env id — backs `GET /v1/environments/:id`. */
  detailByEnvId: Record<string, EnvironmentDetail>;
};

const defaultState = (): EnvironmentsMswState => ({
  environmentsByAppId: {},
  detailByEnvId: {},
});

let state = defaultState();

export function resetEnvironmentsMswState() {
  state = defaultState();
}

/**
 * Seed the env list for one or more app ids. Each entry is the full set of
 * envs `GET /v1/environments` returns for that `X-Outerlayer-App-Id`.
 */
export function seedEnvironmentsMswState(
  environmentsByAppId: Record<string, Environment[]>,
) {
  state = {
    ...defaultState(),
    environmentsByAppId: { ...environmentsByAppId },
  };
}

export const environmentsHandlers = [
  http.get(`${GATEWAY_URL}/v1/environments`, ({ request }) => {
    const appId = request.headers.get('x-outerlayer-app-id') ?? '';
    const environments = state.environmentsByAppId[appId] ?? [];

    return HttpResponse.json({
      data: environments,
      pagination: {
        total: environments.length,
        limit: environments.length,
        offset: 0,
      },
    });
  }),

  // `useCreateEnvironment` — POST a non-default env. The new env is appended
  // to that app's GET list so a follow-up SWR revalidation surfaces it.
  http.post(`${GATEWAY_URL}/v1/environments`, async ({ request }) => {
    const appId = request.headers.get('x-outerlayer-app-id') ?? '';
    const body = (await request.json()) as { name: string };

    const created: Environment = {
      id: `env-created-${body.name}`,
      name: body.name,
      is_default: false,
      current_version: 0,
      current_commit_sha: null,
      epoch: 0,
      created_at: '2026-01-03T00:00:00Z',
      created_by_id: 'user-1',
    };

    state.environmentsByAppId[appId] = [
      ...(state.environmentsByAppId[appId] ?? []),
      created,
    ];

    return HttpResponse.json({
      data: {
        ...created,
        api_key_creation_url: `/orgs/o/apps/a/settings/api-keys?env=${created.id}`,
      },
    });
  }),

  // `useEnvironment` — env detail. A 404 for an unseeded id mirrors the
  // gateway's "env no longer exists" response.
  http.get(`${GATEWAY_URL}/v1/environments/:id`, ({ params }) => {
    const envId = String(params.id);
    const detail = state.detailByEnvId[envId];
    if (!detail) {
      return HttpResponse.json(
        { error: { code: 'not_found', message: 'Environment not found' } },
        { status: 404 },
      );
    }
    return HttpResponse.json({ data: detail });
  }),
];
