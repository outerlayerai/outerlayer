import 'server-only'

/**
 * The bridge to the PR-outcomes read cluster (`src/lib/system/outcome-scores`,
 * `src/lib/system/pr-session-reconciler`): shared infra consumed by the GitHub
 * PR webhook, the reconciler/sweep cron, and `pr-outcome-correlation` — a
 * feature service calls it rather than absorbing it, so it stays one door for
 * every caller. Both functions already take their tenant scope / a passed
 * RLS-scoped client as arguments and open no client of their own.
 */
export { tenantChQuery } from '@/lib/system/pr-session-reconciler/ch-query'
export { fetchSessionOutcomeScores } from '@/lib/system/outcome-scores/session-outcome-read'
export { getSessionListOutcomes } from '@/lib/system/outcome-scores/session-list-outcomes'
