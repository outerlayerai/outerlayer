/**
 * action-kit — the mutation/service layer contract.
 * Framework-thin and Supabase-free: clients are interfaces satisfied by later wiring.
 */

export { authorizedAction, ActionForbiddenError } from './authorized-action';
export { preTenantAction } from './pre-tenant-action';
export { ActionErrorCodes } from './result';
