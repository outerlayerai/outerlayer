/**
 * `isAuditedPermission` / `AUDITED_PERMISSION_SUFFIXES` — the one definition
 * of which denial verbs are audit-worthy. A silently narrowed set stops
 * auditing a whole verb class with no other visible symptom, so the set
 * membership is pinned exactly rather than spot-checked.
 */

import { AUDITED_PERMISSION_SUFFIXES, isAuditedPermission } from '../index';

// proves AC-4a
it('admits exactly the seven granular write verbs', () => {
  expect([...AUDITED_PERMISSION_SUFFIXES].sort()).toEqual([
    'delete',
    'insert',
    'promote',
    'review',
    'run',
    'update',
    'write',
  ]);
});

it('classifies a permission by its verb suffix', () => {
  expect(isAuditedPermission('api_key.insert')).toBe(true);
  expect(isAuditedPermission('api_key.update')).toBe(true);
  expect(isAuditedPermission('api_key.delete')).toBe(true);
  expect(isAuditedPermission('api_key.read')).toBe(false);
  expect(isAuditedPermission('environment.promote')).toBe(true);
  expect(isAuditedPermission('worker_run.run')).toBe(true);
});
