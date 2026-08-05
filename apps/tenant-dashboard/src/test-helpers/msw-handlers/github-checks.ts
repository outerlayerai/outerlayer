/**
 * GitHub Checks API MSW handlers.
 *
 * Octokit's `rest.checks.create` and `rest.checks.update` ultimately make HTTP
 * calls to `api.github.com/repos/:owner/:repo/check-runs[/:id]`. Tests
 * exercising `services/git/github/checks.ts` (and the webhook route that wires
 * it in) cross that HTTP boundary, so we intercept here per the
 * tenant-dashboard testing rule: no hand-rolled Octokit mocks — every HTTP
 * crossing goes through MSW.
 *
 * State is read-only via {@link getCreatedCheckRuns} / {@link getUpdatedCheckRuns}
 * so tests can assert against the actual request shapes Octokit sent. Forced
 * errors via `seedGithubChecksMswState({ forceCreateError, forceUpdateError })`
 * cover the graceful-degradation paths in the webhook handler.
 */

import { http, HttpResponse } from 'msw';

const GITHUB_API = 'https://api.github.com';

type CreatedCheckRun = {
  owner: string;
  repo: string;
  body: Record<string, unknown>;
  id: number;
};

type UpdatedCheckRun = {
  owner: string;
  repo: string;
  checkRunId: number;
  body: Record<string, unknown>;
};

type GithubChecksMswState = {
  /** Auto-incrementing ID used as the response `id` for new check runs. */
  nextCheckRunId: number;
  created: CreatedCheckRun[];
  updated: UpdatedCheckRun[];
  /** Forces POST /check-runs to return an error response (status + message). */
  forceCreateError?: { status: number; message: string };
  /** Forces PATCH /check-runs/:id to return an error response (status + message). */
  forceUpdateError?: { status: number; message: string };
};

const defaultState = (): GithubChecksMswState => ({
  nextCheckRunId: 1000,
  created: [],
  updated: [],
});

let state = defaultState();

export function resetGithubChecksMswState() {
  state = defaultState();
}

export function seedGithubChecksMswState(
  next: Partial<GithubChecksMswState>,
) {
  state = {
    ...state,
    ...next,
    created: next.created ?? state.created,
    updated: next.updated ?? state.updated,
  };
}

/** Read-only views for assertions. */
export function getCreatedCheckRuns(): ReadonlyArray<CreatedCheckRun> {
  return state.created;
}

export function getUpdatedCheckRuns(): ReadonlyArray<UpdatedCheckRun> {
  return state.updated;
}

export const githubChecksHandlers = [
  http.post(
    `${GITHUB_API}/repos/:owner/:repo/check-runs`,
    async ({ request, params }) => {
      if (state.forceCreateError) {
        return HttpResponse.json(
          { message: state.forceCreateError.message },
          { status: state.forceCreateError.status },
        );
      }
      const body = (await request.json()) as Record<string, unknown>;
      const id = state.nextCheckRunId++;
      state.created.push({
        owner: params.owner as string,
        repo: params.repo as string,
        body,
        id,
      });
      // Minimal subset of the actual GitHub response — Octokit's typed return
      // wants `id` (number) and a few status fields. Tests assert on the
      // recorded request body, not the response shape.
      return HttpResponse.json({
        id,
        name: body.name,
        head_sha: body.head_sha,
        status: body.status ?? 'queued',
        conclusion: null,
        url: `${GITHUB_API}/repos/${params.owner}/${params.repo}/check-runs/${id}`,
        html_url: null,
        details_url: null,
        external_id: null,
        started_at: body.started_at ?? null,
        completed_at: null,
        output: {
          title: null,
          summary: null,
          text: null,
          annotations_count: 0,
          annotations_url: null,
        },
      });
    },
  ),

  http.patch(
    `${GITHUB_API}/repos/:owner/:repo/check-runs/:check_run_id`,
    async ({ request, params }) => {
      if (state.forceUpdateError) {
        return HttpResponse.json(
          { message: state.forceUpdateError.message },
          { status: state.forceUpdateError.status },
        );
      }
      const body = (await request.json()) as Record<string, unknown>;
      const checkRunId = Number(params.check_run_id);
      state.updated.push({
        owner: params.owner as string,
        repo: params.repo as string,
        checkRunId,
        body,
      });
      return HttpResponse.json({
        id: checkRunId,
        status: body.status ?? 'in_progress',
        conclusion: body.conclusion ?? null,
      });
    },
  ),
];
