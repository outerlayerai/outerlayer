# outerlayer-site

Marketing site for Outerlayer: local-first session capture, insights, and
PR-mined evals for teams running coding agents.

The visual system comes from `@repo/design-tokens` — the same source the
tenant-dashboard theme composes from. The root layout injects both color
schemes as `--am-*` CSS variables and every Tailwind color utility resolves
through them, so the site cannot drift from the product theme. Type is Geist
(UI) and JetBrains Mono (code), matching the dashboard.

## Run locally

```
yarn workspace outerlayer-site dev
```

Serves on port 9010 by default. Light/dark follows the system preference, with
a header toggle persisted to localStorage.

## Deployment

Vercel project `outerlayer-site`, Root Directory `apps/outerlayer-site`. Every
route is statically prerendered and the site reads no environment variables, so
a deploy needs no configuration beyond the project itself.

- **Production** — a merge to `main`. `vercel.json` gates the build through
  `scripts/should-deploy.sh`, so a merge that touches neither this app nor
  `packages/` skips the build entirely.
- **Preview** — comment `/deploy-preview` on a PR that touches this app.
  Vercel's own git previews are disabled by the same gate.

`lib/site.ts` pins the canonical origin and gates indexing on the deployment
actually being served as that domain — any other deployment, including a
production build still on its `*.vercel.app` URL, serves `Disallow: /` and a
`noindex` meta tag. Attaching `outerlayer.ai` to the project and redeploying is
what opens the site to crawlers.
