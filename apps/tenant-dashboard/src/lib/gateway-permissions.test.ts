import { describe, it, expect } from 'vitest';
import {
  GATEWAY_PERMISSIONS,
  GATEWAY_ROLES,
  PERMISSION_CATEGORIES,
  getPermissionsForRole,
} from './gateway-permissions';

describe('gateway-permissions', () => {
  describe('GATEWAY_PERMISSIONS', () => {
    it('should have 19 permission entries', () => {
      // 12 grantable permissions are absent because their surfaces are gone:
      // template.read, score_config.read, dataset.{read,write},
      // annotation_queue.{read,write,delete,review}, and
      // alert.{read,insert,update,delete}. Scores (write/read/delete) survive
      // because score WRITES are still shape-validated. experiment.read and
      // environment.promote are gone too — they gated no route and no RLS
      // policy. agents.sessions.team.read is new — it controls actor
      // identity visibility on session reads for machine keys.
      expect(GATEWAY_PERMISSIONS).toHaveLength(19);
    });

    it('must NOT offer tenant-tier app management permissions', () => {
      // Security invariant: API keys are app-scoped, but app create/update/
      // delete authorize on tenant_id alone (no app-binding enforcement), so
      // granting them to a key lets it act on every app in the tenant. They must never
      // appear in the grantable vocabulary — VALID_PERMISSION_KEYS in
      // api-keys/actions.ts is derived from this list, so their absence here is
      // what makes the server action reject them.
      const keys = GATEWAY_PERMISSIONS.map((p) => p.key);
      expect(keys).not.toContain('app.insert');
      expect(keys).not.toContain('app.update');
      expect(keys).not.toContain('app.delete');
      // app.read remains grantable (read your own app; read-only preset uses it).
      expect(keys).toContain('app.read');
    });

    it('should have key, label, category, and isDefault on every permission', () => {
      for (const perm of GATEWAY_PERMISSIONS) {
        expect(perm).toHaveProperty('key');
        expect(perm).toHaveProperty('label');
        expect(perm).toHaveProperty('category');
        expect(perm).toHaveProperty('isDefault');
        expect(typeof perm.key).toBe('string');
        expect(typeof perm.label).toBe('string');
        expect(typeof perm.category).toBe('string');
        expect(typeof perm.isDefault).toBe('boolean');
      }
    });

    it('should have unique keys across all permissions', () => {
      const keys = GATEWAY_PERMISSIONS.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('should mark exactly 3 permissions as default', () => {
      const defaults = GATEWAY_PERMISSIONS.filter((p) => p.isDefault);
      expect(defaults).toHaveLength(3);
    });

    it('should have the correct 3 default permissions', () => {
      const defaultKeys = GATEWAY_PERMISSIONS
        .filter((p) => p.isDefault)
        .map((p) => p.key)
        .sort();
      expect(defaultKeys).toEqual([
        'score.write',
        'trace.read',
        'trace.write',
      ]);
    });
  });

  describe('GATEWAY_ROLES', () => {
    it('should have 4 role entries', () => {
      expect(GATEWAY_ROLES).toHaveLength(4);
    });

    it('should have sdk, read-only, full-access, and custom roles', () => {
      const ids = GATEWAY_ROLES.map((r) => r.id);
      expect(ids).toEqual(['sdk', 'read-only', 'full-access', 'custom']);
    });

    it('should assign exactly 2 permissions to sdk role', () => {
      const sdk = GATEWAY_ROLES.find((r) => r.id === 'sdk')!;
      expect(sdk.permissions).toEqual(['trace.write', 'score.write']);
    });

    it('should assign 7 read permissions to read-only role', () => {
      // Read-only additions, in order: environment.read,
      // app.read (app CRUD moved into gateway);
      // score_config.read and dataset.read are absent from this preset because
      // their surfaces are gone.
      const readOnly = GATEWAY_ROLES.find((r) => r.id === 'read-only')!;
      expect(readOnly.permissions).toHaveLength(7);
      expect(readOnly.permissions).toEqual([
        'trace.read',
        'span.read',
        'session.read',
        'score.read',
        'metrics.read',
        'environment.read',
        'app.read',
      ]);
    });

    it('should assign all 19 permissions to full-access role', () => {
      const fullAccess = GATEWAY_ROLES.find((r) => r.id === 'full-access')!;
      expect(fullAccess.permissions).toHaveLength(19);
      const allKeys = GATEWAY_PERMISSIONS.map((p) => p.key);
      expect([...fullAccess.permissions]).toEqual(allKeys);
      // Even "full access" must not be able to grant tenant-tier app mgmt.
      expect(fullAccess.permissions).not.toContain('app.delete');
    });

    it('should assign empty permissions to custom role', () => {
      const custom = GATEWAY_ROLES.find((r) => r.id === 'custom')!;
      expect(custom.permissions).toEqual([]);
    });

    it('should have label and description on every role', () => {
      for (const role of GATEWAY_ROLES) {
        expect(typeof role.label).toBe('string');
        expect(role.label.length).toBeGreaterThan(0);
        expect(typeof role.description).toBe('string');
        expect(role.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('PERMISSION_CATEGORIES', () => {
    it('should contain unique category names', () => {
      expect(new Set(PERMISSION_CATEGORIES).size).toBe(PERMISSION_CATEGORIES.length);
    });

    it('should include all categories from GATEWAY_PERMISSIONS', () => {
      const categoriesFromPerms = new Set(GATEWAY_PERMISSIONS.map((p) => p.category));
      expect(PERMISSION_CATEGORIES.sort()).toEqual([...categoriesFromPerms].sort());
    });

    it('should have 9 categories', () => {
      // Four categories are absent because their surfaces are gone:
      // Templates, Datasets, Annotation Queues, and Slack. Experiments is
      // gone too — experiment.read was its only permission.
      expect(PERMISSION_CATEGORIES).toHaveLength(9);
    });
  });

  describe('getPermissionsForRole', () => {
    it('should return sdk permissions when role is sdk', () => {
      expect(getPermissionsForRole('sdk')).toEqual([
        'trace.write',
        'score.write',
      ]);
    });

    it('should return read-only permissions when role is read-only', () => {
      const result = getPermissionsForRole('read-only');
      expect(result).toHaveLength(7);
      expect(result).toContain('trace.read');
      expect(result).toContain('span.read');
      expect(result).toContain('score.read');
      expect(result).toContain('environment.read');
      expect(result).toContain('app.read');
    });

    it('should return all permissions when role is full-access', () => {
      expect(getPermissionsForRole('full-access')).toHaveLength(19);
    });

    it('should return empty array when role is custom', () => {
      expect(getPermissionsForRole('custom')).toEqual([]);
    });

    it('should return empty array when role does not exist', () => {
      expect(getPermissionsForRole('nonexistent')).toEqual([]);
    });

    it('should return a new array (not a reference to the role definition)', () => {
      const first = getPermissionsForRole('sdk');
      const second = getPermissionsForRole('sdk');
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    });
  });
});
