# @outerlayer/provider-e2b

A `SandboxProvider` implementation backed by [E2B](https://e2b.dev) Firecracker
microVMs — the managed option behind the same interface as `LocalDockerProvider`,
so scaling the eval runner to the cloud is a config flip, not a rewrite.

Built on the official `e2b` SDK (**v2.x**). E2B is the managed vendor here
because its snapshot model is one-to-many: one prepared environment boots many
independent sandboxes, which is exactly the build-once/boot-N shape the eval
runner already needs, and it fits behind the existing provider interface with
no changes to the runner.

## Env model: build once, snapshot, boot N

E2B v2's `createSnapshot()` is one-to-many, so the provider maps directly onto
what `env-prep` expects (the native equivalent of LocalDocker's `container.commit()`):

1. **`prepareEnv`** boots the toolchain template, runs the build recipe ONCE
   (clone repo @ commit, install deps — online), then `createSnapshot()`.
2. **`create`** boots an independent sandbox from that snapshot — dependencies
   are already in the image, so **offline (`network:'none'`) grade sandboxes work
   with no install-time network**.
3. **`dispose` / `cleanupEnvImage`** deletes the snapshot (it's a stored image
   against the account's storage quota). **The loop must call `dispose()` at end
   of run.**

## Usage

```ts
import { E2BProvider, e2bProviderFromEnv } from "@outerlayer/provider-e2b";

// Explicit:
const provider = new E2BProvider({ apiKey: process.env.E2B_API_KEY!, template: "outerlayer-agent" });

// Or feature-flagged (returns null unless OUTERLAYER_E2B_ENABLED=1 + E2B_API_KEY):
const provider = e2bProviderFromEnv() ?? new LocalDockerProvider();
```

`network:'default'` (agent phase) allows egress; `network:'none'` (grade phase)
is fully offline. Secrets ride only per-exec `ExecOpts.env`, never metadata.

## Toolchain template

The base every env snapshots FROM (python/pytest/git/node/claude-code[/codex],
mirroring the LocalDocker `outerlayer-agent:py312` image). Build it once:

```bash
E2B_API_KEY=e2b_*** node templates/build-template.mjs   # programmatic (API-key auth)
# or, CLI form:  e2b template build --name outerlayer-agent --cpu-count 2 --memory-mb 2048
#                (from templates/e2b.Dockerfile)
```

## Tests

```bash
yarn test                                                   # unit (fake E2BApi, no account)
OUTERLAYER_CONFORMANCE=1 E2B_API_KEY=e2b_*** yarn vitest \
  run --testTimeout 240000 src/__tests__/e2b.conformance.test.ts   # live provider conformance (13/13)
```

## Known limitations
- **cpu/mem are template-level** in E2B (not per-`create`); per-create values are
  recorded only for `pidsLimit` (enforced via `ulimit -u`).
- **Egress is a per-sandbox on/off** today (`allowInternetAccess`). Fine-grained
  host allowlisting (agent-phase model-API allowlist) via `updateNetwork()` is a
  documented follow-up.
