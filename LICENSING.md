# Licensing

This repository uses two licenses, depending on directory. The default is
Apache-2.0; the Enterprise-licensed subtrees are covered by the single
canonical file at [`./ee/LICENSE`](./ee/LICENSE) (see its own scope clause
and [`./ee/README.md`](./ee/README.md) for the full EE boundary). This
document is a map and a summary, not the license text itself; the
authoritative per-directory statement is the preamble of the root
[`./LICENSE`](./LICENSE), which this map expands on.

| Path                                                       | License                                                        | Notes                                                                                                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything not listed below                                | [Apache-2.0](./LICENSE)                                        | Default license for the repository — dashboard, gateway, apps, packages, infra, docs. Copyright Magu Studios, Inc.                                                                                          |
| `apps/tenant-dashboard/ee/`, and any directory named `ee/` | [Outerlayer Enterprise License](./ee/LICENSE)                  | Source-available; production use requires a commercial agreement. `./ee/LICENSE` is the canonical text — it is written to cover every directory named `ee` in the repo, so no per-directory copy is needed |

`packages/ee-license/` (the license *verifier*) is deliberately Apache-2.0,
not Enterprise: it has to run on every unlicensed self-hosted instance in
order to deny EE features, so gating it behind the license it checks would be
circular. Only the gated feature implementations under `ee/` directories are
Enterprise-licensed.

The published packages (`@outerlayer/*` and the `outerlayer` CLI) and
`packages/model-registry/` each carry their own verbatim Apache-2.0 `LICENSE`
file so the artifact is self-describing when distributed on its own; the text
matches the root grant (only the copyright line differs).

Most source files under the published packages carry
`// SPDX-License-Identifier: Apache-2.0` headers. A header is a convenience,
not the grant — the governing text is the root `LICENSE` (or the directory's
own copy where one exists), so files without headers are Apache-2.0 all the
same.

## FAQ

**Can I self-host this?**
Yes. Apache-2.0 permits self-hosting, modification, redistribution, and
commercial use of everything outside the `ee/` subtrees, with no copyleft
obligation — you are not required to publish your modifications.

**Can I use the published SDKs/packages in closed-source software?**
Yes. Everything outside the `ee/` subtrees is Apache-2.0, including all
published packages (`@outerlayer/*` and `outerlayer`) — depending on them
carries no copyleft obligation.

**What needs a commercial license?**
Anything under a directory named `ee/` (currently `apps/tenant-dashboard/ee/`)
— see [`./ee/LICENSE`](./ee/LICENSE). These implement enterprise-only
features and are source-available for evaluation, but running them with a
valid license key in production requires a commercial agreement with
Magu Studios, Inc. Running the standard distribution with EE features
disabled by the license-key check does not.

Questions: licensing@outerlayer.ai
