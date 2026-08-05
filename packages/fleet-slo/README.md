# @outerlayer/fleet-slo

Canary-fleet SLOs, a fault-injecting chaos suite, and a release-readiness
gate. Reliability is **measured from live telemetry**, not asserted — this
package computes the objective gate values from the typed trial statuses and
timings that [`@outerlayer/runner-core`](../runner-core) and
[`@outerlayer/trial-harness`](../trial-harness) already emit.

## SLOs

`computeSlos(trials, runs)` → the gate values, `checkSlos` → pass/fail vs the
published gates:

| SLO | Gate |
|---|---|
| Trial infra-error rate | < 3% |
| Unattended completion (qualify-passed → card, zero human touches) | ≥ 90% |
| Silent failures (non-graded trial with no typed reason) | 0 |
| Qualify timing | p50 < 15 min, p95 < 40 min |
| Cost predictability (within ±40% of estimate) | ≥ 80% |

## Release-readiness gate

`evaluateLaunchGate(weeks, signoffs)` encodes the release rule: **two
consecutive green weeks** AND all required sign-offs. One good week is `NO_GO`.
A red latest week breaks the streak. Every blocker is listed by name, so a
single view answers whether the fleet is ready to ship.

## Chaos suite

`FaultInjectingProvider` wraps any `SandboxProvider` with a fault schedule, so
the scenarios run against LocalDocker / Fly / a managed vendor unchanged. The
canonical scenarios (`CHAOS_SCENARIOS`) — kill a sandbox mid-agent, kill it
mid-grade, corrupt an env-cache entry, inject a vendor 500, hang a test at
grade time — each **drive the real trial harness** and assert a **typed
outcome** (`infra_error` retryable, or the correct status) with no hang and no
silent loss. That's the crash-recovery contract, tested:

```ts
const provider = new FaultInjectingProvider(new LocalDockerProvider(), scenario.schedule);
const result = await runTrial(task, config, 0, { provider, ... });
expect(scenario.expectStatusIn).toContain(result.status);   // never a throw, never a hang
if (result.status !== "graded") expect(result.error).toBeTruthy();  // zero silent failures
```

## Scope

This package is the SLO, gate, and chaos engine (14 unit tests, including the
chaos suite driving the real harness). The operational half lives outside it:
the canary fleet configuration (15–20 real repos), the scheduled runs, and the
platform-admin SLO dashboard all consume this engine and need live
infrastructure plus an approved canary list.
