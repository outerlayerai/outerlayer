import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import importPlugin from 'eslint-plugin-import'
import supabaseTestMocksPlugin from '@repo/eslint-config/supabase-test-mocks.mjs'

const SUPABASE_TEST_MOCK_MESSAGE =
  'Do not add module-level Supabase mocks in tenant-dashboard tests. Use shared MSW handlers under src/test-helpers/msw-handlers/ instead.'

/*
 * Enforcement rails for the target layer contract.
 *
 * These rules make the contract structural: a violation fails `lint`, not code
 * review. The codebase runs two architectures side by side while surfaces
 * migrate one at a time. A file's PATH declares which world it belongs to and
 * therefore which rules it obeys:
 *
 *   - src/lib/system/**           system layer: the only home of the service-role
 *                                 (RLS-bypassing) admin client.
 *   - src/features/<d>/service.ts service layer: the only new-world code that opens
 *                                 a Supabase client and runs queries; framework-free.
 *   - src/features/<d>/hooks.ts   client logic; src/lib/hooks, src/lib/app-shell are
 *                                 client too — they never touch the data tier.
 *   - src/lib/adapters/**         the single sanctioned bridge from new-world code to
 *                                 legacy modules; the ONLY place a new→old import is allowed.
 *   - components / actions / RSC  receive data (props, ctx.db from a service);
 *                                 they never open a client themselves.
 *   - ee/features/**              EE's mirror of src/features/** — EE code cannot move
 *                                 into the OSS features tree, but it obeys the same
 *                                 leaves/imports discipline, never the legacy tree directly.
 *
 * The strict tiers are scoped to the new-world homes (empty today), so every
 * surface inherits the contract on arrival while the legacy tree is untouched.
 * Type-only imports (`import type`) are always allowed — a type reference pulls
 * no runtime code into the wrong tier (allowTypeImports).
 */

const SUPABASE_JS = '@supabase/supabase-js'
const SUPABASE_SSR = '@supabase/ssr'

// Constructing a service-role client bypasses RLS; it is an allowlisted
// exception confined to the system layer, never a convenience elsewhere.
const adminClientConstruction = {
  name: SUPABASE_JS,
  importNames: ['createClient'],
  allowTypeImports: true,
  message:
    'The service-role (RLS-bypassing) Supabase client is constructed only in src/lib/system/**. Elsewhere, take the RLS-scoped ctx.db a service already holds.',
}

// The Supabase request client (user-scoped) belongs to the query-running layer;
// components, hooks, and actions receive ctx.db and never open a client.
const requestClient = {
  name: SUPABASE_SSR,
  allowTypeImports: true,
  message:
    'Open a Supabase client only in the service layer (src/features/*/service.ts) or src/lib/system/. Components, hooks, and actions receive ctx.db from a service; they never open a client.',
}

// The admin-client factory is confined to the system layer (which owns it)
// and ee/features/*/service.ts (the EE service classes that mix RLS-scoped
// and admin-authority calls, mirroring the pre-migration service shape).
// Every other new-world tier takes the admin client through a named
// lib/system function, or ctx.db a service already holds.
const adminClientFactoryImport = {
  name: '@/lib/system/admin-client',
  message:
    'getAdminDataClient is confined to src/lib/system/** and ee/features/*/service.ts. Take the admin client through a named lib/system function, or ctx.db from a service.',
}

// Features are leaves: a feature never imports another feature — not even its
// public entry. Composition happens above the feature layer (the route/RSC tree),
// which is not subject to this rule and may import feature entries freely. Within
// a feature, use relative imports.
const crossFeatureInternals = {
  group: ['@/features/*/**', '@ee/features/*/**'],
  message:
    'Features are leaves — never import another feature, not even its public entry (@/features/<domain> or @ee/features/<domain>). Sideways coupling belongs above the feature layer; compose feature entries in the route/RSC tree. Within a feature use relative imports.',
}

// One-way dependency: new-world code may not reach into the legacy tree
// (sections, services, legacy auth, the root Supabase client wrappers). The
// legacy shell may render new slices, never the reverse — the only crossing is
// an explicit named module under src/lib/adapters/.
const legacyWorldImports = {
  group: [
    '@/sections',
    '@/sections/*',
    '@/services',
    '@/services/*',
    '@/auth',
    '@/auth/*',
    '@/supabaseAdminClient',
    '@/supabaseServerClient',
    '@/supabaseFrontendClient',
  ],
  message:
    'New-world code reaches legacy modules (src/sections, src/services, legacy auth, the root Supabase clients) only through src/lib/adapters/ — the single sanctioned bridge. Add a named adapter there rather than importing legacy directly.',
}

// Services and system modules run domain logic, not rendering: a data module that
// imports UI is a layer inversion and stops being unit-testable / gateway-shareable.
const uiModules = {
  group: [
    '@/components',
    '@/components/*',
    '@/features/*/components/*',
    '@mui/*',
    'react-dom',
    'react-dom/*',
  ],
  message:
    'Data and service modules import no UI. Presentation lives in components; a service returns data, it does not render.',
}

const reactRuntime = {
  name: 'react',
  allowTypeImports: true,
  message:
    'Services and system modules hold no React runtime. Move rendering to a component; keep the data tier framework-free.',
}

// Framework-free is what makes a service unit-testable (mock ctx.db) and
// shareable with the gateway: no next/*, no headers()/cookies().
const nextFramework = {
  group: ['next', 'next/*'],
  message:
    'Services are framework-free (no next/*, no headers()/cookies()) so they stay unit-testable and shareable with the gateway. Read request state at the seam and pass it in.',
}

const serverOnlyMarker = {
  name: 'server-only',
  message:
    'A client module must not import "server-only" — that marker poisons the client bundle. Receive server data as props, or fetch a genuinely-live surface from a // live: hook endpoint.',
}

const systemLayerFromClient = {
  group: ['@/lib/system', '@/lib/system/*'],
  message:
    'Client logic never reaches the system layer. Server code calls it and seeds client state via props/context.',
}

const serviceFromClient = {
  group: ['@/features/*/service', '@/features/*/service.ts', '@/features/*/service.tsx'],
  message:
    'Hooks and providers never import a service. Server code calls services and seeds client state via props/provider.',
}

// The two calls that gate a "use server" export: authorizedAction for a
// tenant + permission check, preTenantAction for an authenticated action with
// a declared pre-tenant reason. A hardcoded set of two names, not a rule
// option — an option would be a second place to configure the guarantee, and
// a config edit could widen it without touching the rule.
const ACTION_WRAPPERS = new Set(['authorizedAction', 'preTenantAction'])

// Composition inside a "use client" file: importing server-tier code drags it into
// the client bundle silently. This keeps that footgun a loud lint error, and it
// is clean repo-wide today — no client module reaches server-only, the system
// layer, or a feature service — so it guards every client file, not just new ones.
const layerBoundaries = {
  rules: {
    'no-server-imports-in-client': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'A "use client" module must not import server-tier code (the server-only marker, the system layer, or a feature service). Such an import pulls server code into the client bundle and can leak secrets; pass server content as children instead.',
        },
        schema: [],
        messages: {
          serverInClient:
            'A "use client" module must not import server-tier "{{ source }}". Pass server content as children; never import it into a client module.',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode()

        const isUseClient = () => {
          for (const node of sourceCode.ast.body) {
            if (node.type !== 'ExpressionStatement') break
            const expr = node.expression
            if (expr.type !== 'Literal' || typeof expr.value !== 'string') break
            if (expr.value === 'use client') return true
          }
          return false
        }

        if (!isUseClient()) return {}

        const SERVER_TIER = [
          /^server-only$/,
          /^@\/lib\/system(\/|$)/,
          /(^|\/)lib\/system(\/|$)/,
          /^@\/features\/[^/]+\/service(\.tsx?)?$/,
        ]

        return {
          ImportDeclaration(node) {
            const src = node.source.value
            if (typeof src !== 'string') return
            if (SERVER_TIER.some((re) => re.test(src))) {
              context.report({ node, messageId: 'serverInClient', data: { source: src } })
            }
          },
        }
      },
    },

    // A use* hook that reaches for live server state (fetch/SWR) must say why
    // with a `// live: <reason>` comment. The default is that a hook does NOT
    // fetch — its data is seeded by an RSC provider; a genuine exception (server
    // state that advances without user action, e.g. a "waiting for first trace"
    // poll) documents its liveness inline so the reviewer can see the seam.
    'live-hook-fetch': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'A use* hook that fetches (fetch, an SWR hook, or a Supabase query chain) must carry a `// live: <reason>` comment justifying why the data is live rather than RSC-seeded.',
        },
        schema: [],
        messages: {
          missingLive:
            'This use* hook fetches server state without a `// live: <reason>` comment. If the data is genuinely live (advances without user action), document why with `// live: <reason>`. Otherwise read it from an RSC-seeded provider (or a server action, for a Supabase query) instead of fetching in the client.',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode()
        // A non-empty reason is required — a bare `// live:` does not justify.
        const LIVE_RE = /^\s*live:\s*\S+/
        const hookStack = []

        const fnName = (node) => {
          if (node.id && node.id.name) return node.id.name
          const p = node.parent
          if (!p) return null
          if (p.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name
          if (p.type === 'Property' && p.key.type === 'Identifier') return p.key.name
          if (p.type === 'AssignmentExpression' && p.left.type === 'Identifier') return p.left.name
          return null
        }

        const enter = (node) => {
          const name = fnName(node)
          hookStack.push(name && /^use[A-Z0-9]/.test(name) ? node : null)
        }
        const exit = () => hookStack.pop()

        const currentHook = () => {
          for (let i = hookStack.length - 1; i >= 0; i--) {
            if (hookStack[i]) return hookStack[i]
          }
          return null
        }

        const isFetchOrSwr = (callee) =>
          callee.type === 'Identifier' &&
          (callee.name === 'fetch' || /^useSWR/.test(callee.name))

        // Builtins with a static `.from(...)` the rule must not mistake for a
        // Supabase query chain's `.from("table")` — there is no type checker
        // in an AST-only rule, so this is a syntactic allowlist, not a type test.
        const FROM_BUILTINS = new Set([
          'Array', 'Object', 'Buffer', 'String', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
          'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
          'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
        ])

        // A Supabase query chain starts `<client>.from("table")...`. Syntactic
        // match on the `.from(...)` call itself (not the type of `<client>`) —
        // the rule has no type information — excluding the builtin `.from`
        // statics above so `Array.from(...)` etc. don't false-positive.
        const isSupabaseFrom = (callee) =>
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'from' &&
          !(callee.object.type === 'Identifier' && FROM_BUILTINS.has(callee.object.name))

        return {
          FunctionDeclaration: enter,
          'FunctionDeclaration:exit': exit,
          FunctionExpression: enter,
          'FunctionExpression:exit': exit,
          ArrowFunctionExpression: enter,
          'ArrowFunctionExpression:exit': exit,
          CallExpression(node) {
            if (!isFetchOrSwr(node.callee) && !isSupabaseFrom(node.callee)) return
            const hookNode = currentHook()
            if (!hookNode) return
            const comments = sourceCode.getCommentsInside(hookNode)
            if (!comments.some((c) => LIVE_RE.test(c.value))) {
              context.report({ node, messageId: 'missingLive' })
            }
          },
        }
      },
    },

    // Every export of a "use server" module is an authorizedAction(...) call. A
    // raw exported server action skips the tenancy + permission gate the wrapper
    // applies; the directive alone would let a client invoke it ungated.
    'use-server-export-authorized': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'In a "use server" module every export must be an authorizedAction(...) or preTenantAction(...) call, so no server action is reachable without an explicit gate.',
        },
        schema: [],
        messages: {
          notAuthorized:
            'Every export of a "use server" module must be an authorizedAction(...) or preTenantAction(...) call. A raw server action skips its gate — wrap it: `authorizedAction(...)` for a tenant + permission check, `preTenantAction(...)` for an authenticated action with a declared pre-tenant reason.',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode()

        const isUseServer = () => {
          for (const node of sourceCode.ast.body) {
            if (node.type !== 'ExpressionStatement') break
            const e = node.expression
            if (e.type !== 'Literal' || typeof e.value !== 'string') break
            if (e.value === 'use server') return true
          }
          return false
        }

        if (!isUseServer()) return {}

        const isWrappedActionCall = (init) =>
          !!init &&
          init.type === 'CallExpression' &&
          init.callee.type === 'Identifier' &&
          ACTION_WRAPPERS.has(init.callee.name)

        return {
          Program(program) {
            // Local bindings initialized with a wrapped-action call, so a later
            // `export { foo }` specifier can be resolved to a wrapped action.
            const wrappedBindings = new Set()
            for (const stmt of program.body) {
              const decl =
                stmt.type === 'ExportNamedDeclaration' && stmt.declaration
                  ? stmt.declaration
                  : stmt.type === 'VariableDeclaration'
                    ? stmt
                    : null
              if (decl && decl.type === 'VariableDeclaration') {
                for (const d of decl.declarations) {
                  if (d.id.type === 'Identifier' && isWrappedActionCall(d.init)) {
                    wrappedBindings.add(d.id.name)
                  }
                }
              }
            }

            for (const stmt of program.body) {
              // `export type { ... }` / `export interface` are erased — not runtime actions.
              if (stmt.type === 'ExportNamedDeclaration' && stmt.exportKind === 'type') continue

              if (stmt.type === 'ExportNamedDeclaration') {
                if (stmt.declaration) {
                  const decl = stmt.declaration
                  if (decl.type === 'VariableDeclaration') {
                    for (const d of decl.declarations) {
                      if (!isWrappedActionCall(d.init)) {
                        context.report({ node: d, messageId: 'notAuthorized' })
                      }
                    }
                  } else if (
                    decl.type === 'TSTypeAliasDeclaration' ||
                    decl.type === 'TSInterfaceDeclaration' ||
                    decl.type === 'TSEnumDeclaration'
                  ) {
                    // type-level export — allowed
                  } else {
                    // FunctionDeclaration, ClassDeclaration, etc. — raw, unwrapped
                    context.report({ node: decl, messageId: 'notAuthorized' })
                  }
                } else if (!stmt.source) {
                  // `export { a, b }` — resolve each to a local wrapped binding.
                  for (const spec of stmt.specifiers) {
                    if (spec.exportKind === 'type') continue
                    if (
                      spec.local.type === 'Identifier' &&
                      !wrappedBindings.has(spec.local.name)
                    ) {
                      context.report({ node: spec, messageId: 'notAuthorized' })
                    }
                  }
                }
                // `export { x } from '...'` (has source) — the target module carries
                // its own directive and lint; not verifiable here, left to it.
              } else if (stmt.type === 'ExportDefaultDeclaration') {
                if (!isWrappedActionCall(stmt.declaration)) {
                  context.report({ node: stmt, messageId: 'notAuthorized' })
                }
              }
            }
          },
        }
      },
    },

    // Server identity comes from getUser(), never auth.getSession(): getSession
    // returns the client-cached session without revalidating it against the auth
    // server, so a server tier that trusts it can act on a forged/stale session.
    'no-server-get-session': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Server-tier code must not call auth.getSession(); server identity is established with getUser().',
        },
        schema: [],
        messages: {
          noGetSession:
            'Server identity comes from getUser(), not auth.getSession(): getSession trusts the unrevalidated client-cached session. Call supabase.auth.getUser() in server code.',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee
            if (callee.type !== 'MemberExpression' || callee.computed) return
            if (callee.property.type !== 'Identifier' || callee.property.name !== 'getSession') return
            const obj = callee.object
            const isAuth =
              (obj.type === 'MemberExpression' &&
                !obj.computed &&
                obj.property.type === 'Identifier' &&
                obj.property.name === 'auth') ||
              (obj.type === 'Identifier' && obj.name === 'auth')
            if (isAuth) context.report({ node, messageId: 'noGetSession' })
          },
        }
      },
    },

    // The `use cache` directive caches a function's output across requests; a
    // shared cache keyed without the tenant can hand one tenant's rows to another.
    // It is allowed only under src/lib/static-cache/, where reads are provably
    // tenant-agnostic (config-block ignores enforce that scope).
    'no-shared-use-cache': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'The `use cache` directive is allowed only under src/lib/static-cache/; elsewhere it is a cross-tenant cache-leak footgun.',
        },
        schema: [],
        messages: {
          noUseCache:
            'The `use cache` directive is allowed only under src/lib/static-cache/. A shared cache can serve one tenant’s data to another; put cacheable, tenant-agnostic reads under src/lib/static-cache/.',
        },
      },
      create(context) {
        const checkPrologue = (statements) => {
          for (const stmt of statements) {
            if (stmt.type !== 'ExpressionStatement') break
            const e = stmt.expression
            if (e.type === 'Literal' && e.value === 'use cache') {
              context.report({ node: stmt, messageId: 'noUseCache' })
            }
          }
        }
        const checkFn = (node) => {
          if (node.body && node.body.type === 'BlockStatement') checkPrologue(node.body.body)
        }
        return {
          Program(node) {
            checkPrologue(node.body)
          },
          FunctionDeclaration: checkFn,
          FunctionExpression: checkFn,
          ArrowFunctionExpression: checkFn,
        }
      },
    },
  },
}

// The new-world homes that inherit the full tiered contract. Empty today; the
// strict rules cost nothing now and bind every migrated surface on arrival.
// `ee/features/**` is EE's mirror of `src/features/**` (D3: EE code cannot
// move into the OSS features tree, so it gets its own home, but the same
// leaves/imports discipline binds it from arrival rather than silently not
// applying to the EE tree).
const NEW_WORLD = [
  'src/features/**/*.{ts,tsx}',
  'src/lib/action-kit/**/*.{ts,tsx}',
  'src/lib/system/**/*.{ts,tsx}',
  'src/lib/hooks/**/*.{ts,tsx}',
  'src/lib/app-shell/**/*.{ts,tsx}',
  'src/lib/analytics/**/*.{ts,tsx}',
  'ee/features/**/*.{ts,tsx}',
]

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    // Extra dist dirs for parallel instances (NEXT_DIST_DIR, selfhost e2e).
    '.next-selfhost-*/**',
    'out/**',
    'build/**',
    'coverage/**',
    // Stryker's mutation-run temp dir. Created/destroyed mid-run; linting it
    // races its deletion (ENOENT) when the pre-push mutation + lint gates overlap.
    '.stryker-tmp/**',
    'next-env.d.ts',
    "scripts/**",
    "src/theme/**",
    ".yalc/**",
    // Supabase CLI scratch state (edge-runtime bundles, start secrets) —
    // generated JS/TS the CLI writes on `supabase start`, never our code.
    'supabase/.temp/**',
  ]),
  {
    plugins: {
      import: importPlugin,
    },
    // Apply rules
    rules: {
      "import/no-unused-modules": [
        "error",
        {
          unusedExports: true,
          ignoreExports: [
            "src/app/**",
            "src/test-helpers/**",
            "src/auth/hooks/index.ts",
            "src/proxy.ts",
            "src/instrumentation.ts",
            "src/instrumentation-client.ts",
            "eslint.config.mjs",
            "next.config.mjs",
            "src/types/db.ts",
            "src/types/membership.ts",
            "src/features/org-lifecycle/action-adapters.ts",
            "src/utils/get-user-permissions.ts",
            // The barrel's value exports (buildContextSync,
            // createSupabaseContextMirrorPort) have in-repo consumers; its
            // type re-exports are the public contract for callers outside
            // this package and have none yet.
            "src/lib/system/context-sync/index.ts",
            // refreshPrSessionComment + its params type are the only exports
            // every trigger path actually imports through this barrel; the
            // read-layer/renderer/GitHub-client re-exports are the module's
            // public contract for future callers outside this package and
            // have none yet — current consumers (this package's own tests)
            // import those directly from the sibling files.
            "src/lib/system/pr-session-comment/index.ts",
            // Context save-path backend — the save/create adapter input types
            // land ahead of their UI consumer, a later task.
            "src/features/context/action-adapters.ts",
            "src/lib/system/context-save/save-service.ts",
            // Context editor module — public entry barrel lands ahead of its
            // consumer (the viewer integration at the consolidation task).
            "src/features/context/components/editor/index.ts",
            // action-kit and lib/system public entries: the layer foundations
            // ship ahead of the first migrated feature that consumes them.
            "src/lib/action-kit/index.ts",
            "src/lib/system/index.ts",
            // Shared page-layout primitives: a public surface that pages
            // adopt one at a time, so a barrel can have no in-repo consumer
            // until the page that owns it migrates over.
            "src/components/page-header/index.ts",
            "src/components/empty-state/index.ts",
            "src/components/error-state/index.ts",
            "src/components/page-skeleton/index.ts",
            "src/components/table-pager/index.ts",
            "src/lib/api/generated/**",
            "vitest.config.ts",
            "vitest.integration.config.ts",
            "stryker.config.mjs",
            "stryker.config.money-auth.mjs",
            "stryker.config.patch.mjs"
          ],
        },
      ],
      "react-hooks/exhaustive-deps": "off",
      // Re-enabled: TS's `noUnusedLocals` is the source of truth (catches
      // unused type aliases + private members that ESLint misses), but
      // ESLint flags the JS-shape subset earlier — in-editor and during
      // lint-staged on pre-commit, before tsc gets a chance. Overlapping
      // coverage is intentional. Underscore-prefix is the conventional
      // intentional-unused marker; matches the pattern in
      // packages/eslint-config/{library,react-internal}.mjs.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
    },
  },
  {
    files: ["src/**/*.{test,spec}.{ts,tsx,js,jsx}"],
    plugins: {
      "@repo/supabase-test-mocks": supabaseTestMocksPlugin,
    },
    rules: {
      "@repo/supabase-test-mocks/no-supabase-test-mocks": [
        "error",
        { message: SUPABASE_TEST_MOCK_MESSAGE },
      ],
    },
  },

  // Composition boundary — enforced repo-wide (measured clean today): a "use
  // client" module importing server-tier code is a silent client-bundle leak.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { local: layerBoundaries },
    rules: {
      'local/no-server-imports-in-client': 'error',
    },
  },

  // New-world baseline — no data client outside the data tier; a feature is
  // reached through its public entry; no reach back into the legacy tree.
  {
    files: NEW_WORLD,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [adminClientConstruction, requestClient],
          patterns: [crossFeatureInternals, legacyWorldImports],
        },
      ],
    },
  },

  // Admin-client factory confinement — repo-wide, not just new-world code: a
  // legacy route handler or section-level action must not import
  // `getAdminDataClient` either. A dedicated rule key (the core
  // `no-restricted-imports`, not the typescript-eslint one every other tier
  // block below claims) so this stays additive — flat config resolves the
  // SAME rule key per file from the LAST matching block, so folding this
  // into `@typescript-eslint/no-restricted-imports` would have silently
  // dropped it wherever a later, more specific block (hooks, the adapter
  // bridge, service layer) redefines that key without repeating this path.
  {
    files: ['src/**/*.{ts,tsx}', 'ee/**/*.{ts,tsx}'],
    ignores: ['src/lib/system/**/*.{ts,tsx}', 'ee/features/*/service.ts', 'ee/features/*/service.tsx'],
    rules: {
      'no-restricted-imports': ['error', { paths: [adminClientFactoryImport] }],
    },
  },

  // Same one-way boundary as `legacyWorldImports` above, but resolved by file
  // path rather than matched against the specifier string: `legacyWorldImports`
  // only catches the alias spellings (`@/services/...`), so a relative import
  // that resolves into the same legacy directories (`../../../services/...`)
  // slips past it. `import/no-restricted-paths` resolves both spellings to the
  // same file before matching, closing that gap. `lib/adapters/**` is
  // deliberately outside every zone's `target` — it is the one sanctioned
  // crossing and stays exempt.
  {
    files: NEW_WORLD,
    plugins: { import: importPlugin },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/features/**/*',
              from: ['./src/sections/**/*', './src/services/**/*', './src/auth/**/*'],
              message:
                'New-world code reaches legacy modules (src/sections, src/services, legacy auth) only through src/lib/adapters/ — the single sanctioned bridge, regardless of whether the import is aliased or relative.',
            },
            {
              target: [
                './src/lib/action-kit/**/*',
                './src/lib/system/**/*',
                './src/lib/hooks/**/*',
                './src/lib/analytics/**/*',
                './ee/features/**/*',
              ],
              from: ['./src/sections/**/*', './src/services/**/*', './src/auth/**/*'],
              message:
                'New-world code reaches legacy modules (src/sections, src/services, legacy auth) only through src/lib/adapters/ — the single sanctioned bridge, regardless of whether the import is aliased or relative.',
            },
            {
              // lib/app-shell is the client-tier mirror of lib/adapters — sanctioned
              // only for the legacy auth-context crossing (see use-current-user.ts),
              // never sections or services, which stay off-limits like every other
              // new-world home.
              target: './src/lib/app-shell/**/*',
              from: ['./src/sections/**/*', './src/services/**/*'],
              message:
                'New-world code reaches legacy modules (src/sections, src/services) only through src/lib/adapters/ — the single sanctioned bridge, regardless of whether the import is aliased or relative.',
            },
            {
              target: [
                './src/features/**/*',
                './src/lib/action-kit/**/*',
                './src/lib/system/**/*',
                './src/lib/hooks/**/*',
                './src/lib/app-shell/**/*',
                './src/lib/analytics/**/*',
                './ee/features/**/*',
              ],
              from: [
                './src/supabaseAdminClient.ts',
                './src/supabaseServerClient.ts',
                './src/supabaseFrontendClient.ts',
              ],
              message:
                'The root Supabase client wrappers are legacy modules — reach them only through src/lib/adapters/, regardless of whether the import is aliased or relative.',
            },
          ],
        },
      ],
    },
  },

  // Service layer — the RLS-scoped request client is allowed here; the admin
  // client is not; the module stays framework-free, UI-free, legacy-free.
  {
    files: [
      'src/features/*/service.ts',
      'src/features/*/service.tsx',
      'ee/features/*/service.ts',
      'ee/features/*/service.tsx',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [adminClientConstruction, reactRuntime],
          patterns: [crossFeatureInternals, uiModules, nextFramework, legacyWorldImports],
        },
      ],
    },
  },

  // System layer — the sole home of the service-role admin client; still
  // UI-free, React-free, legacy-free.
  {
    files: ['src/lib/system/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [reactRuntime],
          patterns: [crossFeatureInternals, uiModules, legacyWorldImports],
        },
      ],
    },
  },

  // Named exception, membership-service.ts only: the invite flow delegates
  // per-app role assignment to the EE app-access service — a documented,
  // one-way crossing (ee/README.md), not a mistake. On an unlicensed
  // deployment the call returns entitlement_denied and invites proceed
  // without app roles. The target is a licensed EE service class, not
  // liftable into lib/system without breaking the licensing boundary — so
  // this is an exemption, not a relocation. Named narrowly (this file, this
  // one import) so a widening is visible in a diff. AC pinned in
  // eslint-layer-contract.test.ts.
  {
    files: ['src/lib/system/membership-service.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [reactRuntime],
          patterns: [
            {
              group: [
                '@/features/*/**',
                '@ee/features/*/**',
                '!@ee/features/app-access/app-member-role-service',
              ],
              message: crossFeatureInternals.message,
            },
            uiModules,
            legacyWorldImports,
          ],
        },
      ],
    },
  },

  // Client logic — hooks and providers. They hold no reference to the data tier;
  // server code seeds them through props/context.
  {
    files: [
      'src/features/*/hooks.ts',
      'src/features/*/hooks.tsx',
      'src/features/**/hooks/**/*.{ts,tsx}',
      'src/features/**/use-*.{ts,tsx}',
      'src/lib/hooks/**/*.{ts,tsx}',
      'src/lib/app-shell/**/*.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [adminClientConstruction, requestClient, serverOnlyMarker],
          patterns: [crossFeatureInternals, systemLayerFromClient, serviceFromClient, legacyWorldImports],
        },
      ],
    },
  },

  // Adapter bridge — the ONE place new-world code may import legacy modules
  // (that is its purpose), so the legacy-import ban is lifted here. Every other
  // tier boundary still holds: no admin/request client, no cross-feature internals.
  {
    files: ['src/lib/adapters/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [adminClientConstruction, requestClient],
          patterns: [crossFeatureInternals],
        },
      ],
    },
  },

  // Tenant-coherence backstop — these wrapped-action surfaces resolve tenancy
  // from the request tenant the permission check used (the wrapper's tenantId
  // param), never the JWT claim: reading `app_metadata.tenant_id` here would
  // reintroduce the check-tenant/act-tenant split that lands a write in the wrong
  // org. Shrink-only: this list only ever grows as more surfaces are cleaned.
  // (admin/settings/actions.ts is excluded: its billing actions do their own
  // getUser and are internally claim-consistent, a separate later slice.)
  {
    files: [
      'src/lib/system/membership-service.ts',
      'src/features/api-keys/actions.ts',
      'src/sections/apps/actions/actions.ts',
      'src/sections/apps/actions/delete-app.ts',
      'src/sections/apps/actions/remove-git-files.ts',
      'src/features/context/actions/save-context-file-action.ts',
      'src/features/context/actions/create-context-file-action.ts',
      'src/features/context/actions/commit-context-changes-action.ts',
      'src/features/context/actions/enumerate-skill-deletion-action.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name='tenant_id'][object.property.name='app_metadata']",
          message:
            'Tenancy comes from the resolved request tenant (the wrapper\'s tenantId param), never the JWT claim. Reading app_metadata.tenant_id here reintroduces the check-tenant/act-tenant split.',
        },
        {
          // A no-arg server client is claim-scoped — the same split as reading
          // the claim directly, just implicit. Pass the resolved request tenant
          // (the wrapper's tenantId, or getRequestTenantId() in an unwrapped
          // action). Any legitimately tenant-agnostic use belongs outside these
          // wrapped-action files.
          selector:
            "CallExpression[callee.name='createSupabaseServerClient'][arguments.length=0]",
          message:
            'Pass the resolved request tenant to createSupabaseServerClient(tenantId); a no-arg client scopes to the JWT claim, re-splitting check-tenant from act-tenant.',
        },
        {
          // A literal `undefined` argument is the same claim-scoping as no-arg,
          // just spelled out — the arity check above misses it, so flag it too.
          // (A claim-carrying variable can't be caught here without matching the
          // callee identifier itself; that reintroduction path stays uncovered.)
          selector:
            "CallExpression[callee.name='createSupabaseServerClient'] > Identifier[name='undefined']",
          message:
            'Pass the resolved request tenant to createSupabaseServerClient(tenantId); an explicit undefined scopes to the JWT claim, re-splitting check-tenant from act-tenant.',
        },
      ],
    },
  },

  // Client-hook tier — a use* hook that fetches live server state justifies it
  // with a `// live:` comment; the default is RSC-seeded, not client-fetched.
  {
    files: [
      'src/features/*/hooks.{ts,tsx}',
      'src/features/**/hooks/**/*.{ts,tsx}',
      'src/features/**/use-*.{ts,tsx}',
      'src/lib/hooks/**/*.{ts,tsx}',
      'src/lib/app-shell/**/*.{ts,tsx}',
    ],
    plugins: { local: layerBoundaries },
    rules: {
      'local/live-hook-fetch': 'error',
    },
  },

  // New-world tiers — every export of a "use server" module is an
  // authorizedAction(...) call, so no server action is reachable ungated.
  {
    files: NEW_WORLD,
    plugins: { local: layerBoundaries },
    rules: {
      'local/use-server-export-authorized': 'error',
    },
  },

  // Server tiers — server identity is established with getUser(); the unrevalidated
  // auth.getSession() is banned in the query-running and system layers.
  {
    files: [
      'src/features/*/service.{ts,tsx}',
      'src/lib/system/**/*.{ts,tsx}',
      'src/lib/action-kit/**/*.{ts,tsx}',
    ],
    plugins: { local: layerBoundaries },
    rules: {
      'local/no-server-get-session': 'error',
    },
  },

  // The `use cache` directive is a cross-tenant cache-leak footgun everywhere
  // except the dedicated tenant-agnostic cache home.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/static-cache/**'],
    plugins: { local: layerBoundaries },
    rules: {
      'local/no-shared-use-cache': 'error',
    },
  },
])

export default eslintConfig
