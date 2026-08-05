# @outerlayer/runner-core

The eval runner's portability seam: one thin `SandboxProvider` interface that
the whole harness — checkout → agent → grade — is written against. Local
Docker and Fly Machines are config choices; managed microVM vendors plug in
behind the same interface and must pass the same conformance suite.

## The interface

```ts
interface SandboxProvider {
  readonly id: string;
  prepareEnv(spec: EnvSpec): Promise<EnvRef>;   // idempotent by caller key
  create(env: EnvRef, opts?: SandboxOpts): Promise<Sandbox>;
  exec(sandbox, cmd, opts?): Promise<ExecResult>; // nonzero exit = data, never a throw
  putFiles(sandbox, files: FileMap): Promise<void>;
  getFile(sandbox, path): Promise<Buffer>;       // binary-safe
  destroy(sandbox): Promise<void>;               // idempotent, safe twice
  list(): Promise<SandboxInfo[]>;                // outerlayer-labeled only (reaper's view)
}
```

Normative semantics (enforced by the conformance suite, not just documented):

- **`prepareEnv` is idempotent on `spec.key`** — the caller
  (`@outerlayer/env-prep`) supplies the content hash; a hit never re-runs `build`. The optional `build` callback runs
  caller logic (clone, checkout, setup, health probe) inside a scratch sandbox;
  the provider snapshots the result (LocalDocker: committed image `ol-env:<key>`).
- **`exec` never throws on nonzero exit.** It throws only on transport/provider
  failure. Output capture is bounded (default 1 MiB/stream) with a `truncated`
  flag; timeouts yield `code: 124, timedOut: true` and may leave the process
  running — trials always `destroy` afterwards.
- **Secrets travel only via per-exec `ExecOpts.env`.** Never in `EnvSpec`,
  never at `create` time — those surfaces persist into snapshots and
  `inspect` output. The conformance suite plants a canary and checks both.
- **`network: 'none'` blocks all egress** (grade phase). `'default'` is
  standard egress (agent phase). A true per-host allowlist is a managed-vendor
  and Fly follow-up; the gap is documented rather than faked.
- **Sandboxes are labeled** (`outerlayer-trial`, created-at, env-key) so the
  reaper (`reapOrphans`) can destroy anything a crashed harness left behind —
  the crash-recovery contract is a conformance test.

## Providers

| Provider | Status | Notes |
|---|---|---|
| `LocalDockerProvider` | ✅ conformance-green | dockerode; tmpfs `/scratch`; NanoCpus/Memory/PidsLimit caps |
| `FlyProvider` | next in series | Fly Machines API; per-trial 6PN isolation; conformance runs as a scheduled job on real infra (needs `FLY_API_TOKEN`) |
| managed (E2B/Daytona) | in progress | must pass this suite with zero runner-core edits |

## Conformance suite

`@outerlayer/runner-core/conformance` exports `conformanceSuite(options)` —
a vitest suite any provider embeds in one test file (see
`src/__tests__/local-docker.conformance.test.ts`). Gated behind
`OUTERLAYER_CONFORMANCE=1` because it touches real infrastructure:

```bash
yarn test:conformance   # 13 live checks, ~21s against local Docker
```

Covers: env-build idempotence · warm boot within budget · exit-code
semantics · bounded/truncated output · timeout behavior · binary file
round-trip · secret-canary leak checks (sandbox config + image history) ·
10 parallel sandboxes · destroy idempotence · TTL orphan reaping · egress
blocked/allowed per network mode · fork-bomb containment · zero-leftover
cleanup.

## Telemetry

Every lifecycle transition (`env_prepared`, `sandbox_created`,
`sandbox_destroyed`, `exec_completed`, `reaper_destroyed`) emits a
`LifecycleEvent` to a pluggable `EventSink` (default no-op; `MemorySink`
for tests). The SLO pipeline in [`@outerlayer/fleet-slo`](../fleet-slo)
consumes these.
