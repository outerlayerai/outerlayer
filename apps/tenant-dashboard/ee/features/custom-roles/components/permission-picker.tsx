'use client';

import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Checkbox,
  FormControlLabel,
  Tooltip,
  Typography,
} from '@mui/material';
import Iconify from '@/components/iconify';

import { PERMISSION_GROUPS, PREREQUISITES } from '@/utils/permissions';

// ---------------------------------------------------------------------------
// Prerequisite helpers (module-level, computed once)
// ---------------------------------------------------------------------------

/** Reverse map: if A requires B, then REVERSE_DEPS[B] includes A */
export const REVERSE_DEPS: Record<string, string[]> = (() => {
  const reverse: Record<string, string[]> = {};
  for (const [perm, prereqs] of Object.entries(PREREQUISITES)) {
    for (const prereq of prereqs) {
      (reverse[prereq] ??= []).push(perm);
    }
  }
  return reverse;
})();

/** Collect all prerequisites recursively (breadth-first) */
export function getAllPrerequisites(permission: string): string[] {
  const result = new Set<string>();
  const queue = [...(PREREQUISITES[permission] ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (!result.has(next)) {
      result.add(next);
      queue.push(...(PREREQUISITES[next] ?? []));
    }
  }
  return Array.from(result);
}

/** Collect all dependents recursively (breadth-first) */
export function getAllDependents(permission: string): string[] {
  const result = new Set<string>();
  const queue = [...(REVERSE_DEPS[permission] ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (!result.has(next)) {
      result.add(next);
      queue.push(...(REVERSE_DEPS[next] ?? []));
    }
  }
  return Array.from(result);
}

/** Build display name lookup from PERMISSION_GROUPS */
const KEY_TO_DISPLAY_NAME: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const group of PERMISSION_GROUPS) {
    for (const perm of group.permissions) {
      map[perm.key] = perm.displayName;
    }
  }
  return map;
})();

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type PermissionPickerProps = {
  selectedPermissions: string[];
  onChange: (permissions: string[]) => void;
  disabled?: boolean;
  /** Set of active boolean entitlement keys for the tenant. Groups/permissions
   *  whose entitlementGate is not in this set will be hidden. When omitted all
   *  groups are shown (backwards-compatible). */
  activeEntitlements?: Set<string>;
};

export function PermissionPicker({
  selectedPermissions,
  onChange,
  disabled,
  activeEntitlements,
}: PermissionPickerProps) {
  const selectedSet = new Set(selectedPermissions);

  /**
   * Returns the active dependents of a permission — i.e. dependents that are
   * currently selected. If non-empty, this permission is "locked" and cannot
   * be unchecked directly.
   */
  const getActiveDependents = (permission: string): string[] =>
    getAllDependents(permission).filter((dep) => selectedSet.has(dep));

  const handleToggle = (permission: string) => {
    if (disabled) return;

    if (selectedSet.has(permission)) {
      // Disable: cascade-remove all dependents
      const toRemove = new Set([permission, ...getAllDependents(permission)]);
      onChange(selectedPermissions.filter((p) => !toRemove.has(p)));
    } else {
      // Enable: auto-add all prerequisites recursively
      const toAdd = new Set([permission, ...getAllPrerequisites(permission)]);
      onChange(Array.from(new Set([...selectedPermissions, ...toAdd])));
    }
  };

  const handleToggleGroup = (permKeys: string[]) => {
    if (disabled) return;
    const allSelected = permKeys.every((p) => selectedSet.has(p));

    if (allSelected) {
      // Deselect all: remove group perms + cascade-disable their dependents
      // (only if those dependents aren't kept by something outside the group)
      const toRemove = new Set<string>();
      for (const key of permKeys) {
        toRemove.add(key);
        for (const dep of getAllDependents(key)) {
          toRemove.add(dep);
        }
      }
      onChange(selectedPermissions.filter((p) => !toRemove.has(p)));
    } else {
      // Select all: add group perms + auto-enable their prerequisites
      const toAdd = new Set<string>(permKeys);
      for (const key of permKeys) {
        for (const prereq of getAllPrerequisites(key)) {
          toAdd.add(prereq);
        }
      }
      onChange(Array.from(new Set([...selectedPermissions, ...toAdd])));
    }
  };

  return (
    <Box>
      {PERMISSION_GROUPS.map((group) => {
        // Hide group if its entitlement gate is not active
        if (
          group.entitlementGate &&
          activeEntitlements &&
          !activeEntitlements.has(group.entitlementGate)
        ) {
          return null;
        }

        // Filter individual permissions by their entitlement gate
        const visiblePermissions = group.permissions.filter((perm) => {
          if (
            perm.entitlementGate &&
            activeEntitlements &&
            !activeEntitlements.has(perm.entitlementGate)
          ) {
            return false;
          }
          return true;
        });

        if (visiblePermissions.length === 0) return null;

        const permKeys = visiblePermissions.map((p) => p.key);
        const selectedCount = permKeys.filter((p) => selectedPermissions.includes(p)).length;
        const allSelected = selectedCount === permKeys.length;
        const someSelected = selectedCount > 0 && !allSelected;

        return (
          <Accordion
            key={group.label}
            defaultExpanded={false}
            disableGutters
            variant="outlined"
            sx={{ '&:before': { display: 'none' } }}
          >
            <AccordionSummary expandIcon={<Iconify icon="eva:arrow-ios-downward-fill" />}>
              <FormControlLabel
                onClick={(e) => e.stopPropagation()}
                control={
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={() => handleToggleGroup(permKeys)}
                    disabled={disabled}
                    size="small"
                  />
                }
                label={
                  <Typography variant="subtitle2">
                    {group.label} ({selectedCount}/{permKeys.length})
                  </Typography>
                }
              />
            </AccordionSummary>

            <AccordionDetails sx={{ pl: 4 }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
                {visiblePermissions.map((perm) => {
                  const activeDeps = getActiveDependents(perm.key);
                  const isLocked = activeDeps.length > 0;
                  const tooltipTitle = isLocked
                    ? `Required by: ${activeDeps.map((d) => KEY_TO_DISPLAY_NAME[d] ?? d).join(', ')}`
                    : '';

                  return (
                    <Tooltip key={perm.key} title={tooltipTitle} placement="right">
                      <FormControlLabel
                        sx={{ width: '45%', minWidth: 120 }}
                        control={
                          <Checkbox
                            checked={selectedPermissions.includes(perm.key)}
                            onChange={() => handleToggle(perm.key)}
                            disabled={disabled || isLocked}
                            size="small"
                          />
                        }
                        label={<Typography variant="body2">{perm.displayName}</Typography>}
                      />
                    </Tooltip>
                  );
                })}
              </Box>
            </AccordionDetails>
          </Accordion>
        );
      })}
    </Box>
  );
}
