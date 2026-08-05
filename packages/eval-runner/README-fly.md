# Eval worker on Fly (ephemeral Machine per run)

Production executor = one ephemeral Fly Machine per eval run. The dashboard route
(`POST /api/apps/[appId]/evals/runs`) creates a queued `eval_run`, mints the run's
gateway key, then starts a run-once worker Machine (`auto_destroy=true`) with the
run's coordinates in its env. The worker (`eval-worker.mjs`) fetches its job from
the GATEWAY, runs it on E2B, persists trials + trajectories, reports the terminal
status (which writes the Report Card AND revokes the key), and exits — the Machine
self-destructs, so **idle cost is $0**. The client already polls `runs/[runId]`.

**Least-privilege model (2026-07-13): the worker holds NO database credential.**
Its only secret is `EVAL_GATEWAY_KEY` — a per-run key (env-bound, named
`eval-run:{runId}`, `score.write`+`trace.write`, 24h expiry) that the gateway
revokes at terminal status. All control-plane I/O goes through gateway endpoints
bound server-side to exactly this run (`GET /v1/evals/runs/{id}/job`,
`POST /v1/evals/runs/{id}/status`, `POST /v1/evals/escalations`).

```
dashboard route ──POST /apps/{app}/machines (auto_destroy)──▶ Fly Machine
   │  creates eval_run(queued), mints per-run key                │ runs eval-worker.mjs
   ▼                                                             │  → GET job / claim
eval_run (Supabase) ◀── gateway writes card/status, revokes key ─┘  → runReport → E2B
   ▲  client polls runs/[runId]                                     → persist → complete
```

## One-time setup

1. **Create the app** (image + secret holder; no machines yet):
   ```bash
   fly apps create outerlayer-eval-worker
   ```
2. **Set APP secrets** (inherited by every run Machine at boot). E2B only — the
   worker holds no Supabase credential:
   ```bash
   fly secrets set --app outerlayer-eval-worker \
     E2B_API_KEY=e2b_*** \
     OUTERLAYER_E2B_TEMPLATE=outerlayer-agent
   ```
3. **Publish the image** (build context = repo root):
   ```bash
   fly deploy -c packages/eval-runner/fly.toml \
     --dockerfile packages/eval-runner/Dockerfile \
     --build-only --push
   # → registry.fly.io/outerlayer-eval-worker:<tag>
   ```
4. **Point the dispatcher (dashboard) at it** — set these where the dashboard runs:
   ```
   FLY_API_TOKEN=<org/app-scoped deploy token>   # fly tokens create deploy -a outerlayer-eval-worker
   FLY_WORKER_APP=outerlayer-eval-worker
   FLY_WORKER_IMAGE=registry.fly.io/outerlayer-eval-worker:<tag>
   FLY_WORKER_REGION=iad                          # optional
   ```
   When `FLY_API_TOKEN` + `FLY_WORKER_APP` + `FLY_WORKER_IMAGE` are all present,
   `flyDispatchFromEnv()` engages and the route dispatches to Fly. Otherwise it
   falls back to the local `EVAL_EXECUTOR_URL` executor (dev).

## What the dispatcher sends (and what it never sends)

Machine config carries the run's coordinates: `RUN_ID`, `EVAL_APP_ID`,
`EVAL_GATEWAY_URL`, `OUTERLAYER_E2B_ENABLED`, `OUTERLAYER_E2B_TEMPLATE`, and
`EVAL_GATEWAY_KEY` — the run's own scoped, short-lived, terminal-status-revoked
key. That key is the ONLY secret-shaped value here, a conscious trade: Machine
config is readable by `FLY_API_TOKEN` holders, and what a reader gains is one
run's self-destructing credential — never a service role, app secret, or model
key (E2B stays in Fly app secrets; model keys go per-exec into sandboxes only).
`restart.policy=on-failure` retries a transient worker crash; the dispatcher
retries transient Machines-API errors.

## Operational notes / follow-ups

- **Idempotency:** the dispatcher flips `eval_run` to `running` before creating the
  Machine; use the `eval_run` status as the dedupe lock (don't dispatch a `runId`
  already `running`/terminal).
- **Watchdog:** a Machine that dies without writing a terminal status leaves the
  row `running` — add a reaper that fails runs stuck past a max wall-clock.
- **Slimmer image:** the Dockerfile builds the whole workspace; a `turbo prune`
  stage would shrink it — optimization, not blocker.
- **Real agents/tasks:** the worker runs scripted agents on fixtures today (proves
  the plumbing). Swapping in real mined tasks + real launchers is orthogonal; when
  it lands, launcher model keys should come through a gateway endpoint scoped by
  the per-run key — never a database credential on the worker.
