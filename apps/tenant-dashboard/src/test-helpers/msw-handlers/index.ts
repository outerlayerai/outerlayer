import { resetSupabaseMswState, supabaseHandlers } from './supabase';
import { apiKeysHandlers, resetApiKeysMswState } from './api-keys';
import {
  managedDeploymentTablesHandlers,
  resetManagedDeploymentTablesState,
} from './managed-deployment-tables';
import { resetVaultMswState, vaultHandlers } from './vault';
import { environmentsHandlers, resetEnvironmentsMswState } from './environments';
import { resetGatewaySession } from './frontend-session';
import {
  githubChecksHandlers,
  resetGithubChecksMswState,
} from './github-checks';
import {
  permissionsHandlers,
  resetPermissionsMswState,
} from './permissions';
import { evalRunHandlers, resetEvalRunMswState } from './eval-run';
import { envEscalationHandlers, resetEnvEscalationMswState } from './env-escalation';
import { workerRunHandlers, resetWorkerRunMswState } from './worker-run';
import { workerEnvironmentHandlers, resetWorkerEnvironmentMswState } from './worker-environment';
import { auditLogHandlers, resetAuditLogMswState } from './audit-log';
import { membershipHandlers, resetMembershipMswState } from './membership';
import { contextSaveHandlers, resetContextSaveMswState } from './context-save';
import {
  contextSyncEventHandlers,
  resetContextSyncEventMswState,
} from './context-sync-event';
import {
  gitConnectionHandlers,
  resetGitConnectionMswState,
} from './git-connection';
import {
  contextSnapshotHandlers,
  resetContextSnapshotMswState,
} from './context-snapshot';
import {
  pullRequestSessionHandlers,
  resetPullRequestSessionMswState,
} from './pull-request-session';
import { appsListHandlers, resetAppsListMswState } from './apps-list';
import { aiCostConfigHandlers, resetAiCostConfigMswState } from './ai-cost-config';
import {
  prSessionCommentHandlers,
  resetPrSessionCommentMswState,
} from './pr-session-comment';

export {
  seedPullRequestSessionMswState,
  getPullRequestSessionLinks,
  type PullRequestMswRow,
  type PullRequestSessionMswRow,
} from './pull-request-session';

export { seedApiKeysMswState } from './api-keys';
export {
  getInsertedGitConnections,
  getDeletedGitBranchTenantHeaders,
  seedGitConnectionUpsertError,
} from './git-connection';
export {
  seedEvalRunMswState,
  getEvalRunMswState,
  type EvalRunMswRow,
} from './eval-run';
export {
  seedEnvEscalationMswState,
  getEnvEscalationMswState,
  type EnvEscalationMswRow,
} from './env-escalation';
export {
  seedWorkerRunMswState,
  getWorkerRunMswState,
  getWorkerRunEventMswState,
} from './worker-run';
export {
  seedWorkerEnvironmentMswState,
  getWorkerEnvironmentMswState,
} from './worker-environment';
export {
  getSupabaseMswState,
  seedPlatformAdminAccess,
  seedSupabaseAuth,
  seedSupabaseMswState,
  seedSupabaseOtpVerification,
  getUpsertedEntitlementOverrides,
  getDeletedEntitlementOverrides,
  getUpdatedBilling,
  getProfileUpdateCalls,
  type SavedTraceFilterRow,
} from './supabase';
export {
  seedManagedDeploymentTablesState,
  getUpdatedGitConnections,
} from './managed-deployment-tables';
export { seedVaultMswState, getVaultMswState } from './vault';
export { seedEnvironmentsMswState } from './environments';
export { seedGatewaySession } from './frontend-session';
export {
  seedGithubChecksMswState,
  getCreatedCheckRuns,
  getUpdatedCheckRuns,
} from './github-checks';
export {
  seedPermissionsMswState,
  getAuthorizeCalls,
  getAppAuthorizeCalls,
} from './permissions';
export {
  seedAuditLogMswState,
  getInsertedAuditLogRows,
  type AuditLogMswRow,
} from './audit-log';
export {
  seedMembershipMswState,
  getMembershipRpcCalls,
  type MembershipMswRow,
  type AppMemberRoleMswRow,
} from './membership';
export {
  seedContextSaveMswState,
  getPatchedContextHeads,
} from './context-save';
export {
  seedContextSyncEventMswState,
  getInsertedContextSyncEvents,
} from './context-sync-event';
export {
  seedContextSnapshotMswState,
  getCreateSnapshotCalls,
} from './context-snapshot';
export {
  seedAppsListMswState,
  getCapturedAppsListSelect,
  type AppsListMswRow,
} from './apps-list';
export { seedAiCostConfigMswState } from './ai-cost-config';
export {
  seedPrSessionCommentMswState,
  getPrSessionCommentRows,
  type PrSessionCommentMswRow,
} from './pr-session-comment';

// MSW resolves handlers in registration order; the FIRST matching handler
// wins. We register managed-deployment-tables BEFORE the shared supabase
// handlers so its app/git_connection/env_var handlers take precedence when
// tests have seeded their state.
export const mswHandlers = [
  ...appsListHandlers,
  ...gitConnectionHandlers,
  ...managedDeploymentTablesHandlers,
  ...supabaseHandlers,
  ...apiKeysHandlers,
  ...vaultHandlers,
  ...environmentsHandlers,
  ...githubChecksHandlers,
  ...permissionsHandlers,
  ...evalRunHandlers,
  ...envEscalationHandlers,
  ...workerRunHandlers,
  ...workerEnvironmentHandlers,
  ...auditLogHandlers,
  ...membershipHandlers,
  ...contextSaveHandlers,
  ...contextSyncEventHandlers,
  ...contextSnapshotHandlers,
  ...pullRequestSessionHandlers,
  ...aiCostConfigHandlers,
  ...prSessionCommentHandlers,
];

export function resetMswState() {
  resetSupabaseMswState();
  resetApiKeysMswState();
  resetManagedDeploymentTablesState();
  resetVaultMswState();
  resetEnvironmentsMswState();
  resetGatewaySession();
  resetGithubChecksMswState();
  resetPermissionsMswState();
  resetEvalRunMswState();
  resetEnvEscalationMswState();
  resetWorkerRunMswState();
  resetWorkerEnvironmentMswState();
  resetAuditLogMswState();
  resetMembershipMswState();
  resetContextSaveMswState();
  resetContextSyncEventMswState();
  resetContextSnapshotMswState();
  resetPullRequestSessionMswState();
  resetGitConnectionMswState();
  resetAppsListMswState();
  resetAiCostConfigMswState();
  resetPrSessionCommentMswState();
}
