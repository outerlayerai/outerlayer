"use client";

import {
  Select,
  MenuItem,
  Divider,
  ListSubheader,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material";
import { UserRoleEnum } from "@/lib/app-shell/use-current-user";
import Iconify from "@/components/iconify";

interface CustomRoleOption {
  id: string;
  name: string;
}

interface RoleSelectDropdownProps {
  /** Either an app_role name (e.g. "admin") or "custom:<uuid>" for custom roles */
  value: string;
  onChange: (value: string) => void;
  customRoles?: CustomRoleOption[];
  customRolesEnabled?: boolean;
  onCreateRole?: () => void;
  disabled?: boolean;
  size?: "small" | "medium";
  /** Whether to show the Owner option (only for owners) */
  showOwner?: boolean;
  /** Whether to exclude the disabled role */
  excludeDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUILT_IN_ROLES = [
  { value: UserRoleEnum.OWNER, label: "Owner" },
  { value: UserRoleEnum.ADMIN, label: "Admin" },
  { value: UserRoleEnum.WRITE, label: "Write" },
  { value: UserRoleEnum.READ, label: "Read" },
  { value: UserRoleEnum.DISABLED, label: "Disabled" },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RoleSelectDropdown({
  value,
  onChange,
  customRoles,
  customRolesEnabled = false,
  onCreateRole,
  disabled = false,
  size = "small",
  showOwner = false,
  excludeDisabled = true,
}: RoleSelectDropdownProps) {
  const handleChange = (event: SelectChangeEvent<string>) => {
    const selected = event.target.value;

    // Intercept the "create new role" sentinel -- do not propagate as a value change
    if (selected === "__create_new_role__") {
      onCreateRole?.();
      return;
    }

    onChange(selected);
  };

  const filteredBuiltInRoles = BUILT_IN_ROLES.filter((role) => {
    if (!showOwner && role.value === UserRoleEnum.OWNER) return false;
    if (excludeDisabled && role.value === UserRoleEnum.DISABLED) return false;
    return true;
  });

  const hasCustomRoles = customRoles && customRoles.length > 0;

  return (
    <Select<string>
      value={value}
      onChange={handleChange}
      disabled={disabled}
      size={size}
      fullWidth
    >
      {/* Built-in Roles section */}
      <ListSubheader>Built-in Roles</ListSubheader>
      {filteredBuiltInRoles.map((role) => (
        <MenuItem key={role.value} value={role.value}>
          {role.label}
        </MenuItem>
      ))}

      {/* Custom Roles section */}
      {hasCustomRoles && <Divider />}
      {hasCustomRoles && <ListSubheader>Custom Roles</ListSubheader>}
      {hasCustomRoles &&
        customRoles.map((role) => (
          <MenuItem key={role.id} value={`custom:${role.id}`}>
            {role.name}
          </MenuItem>
        ))}

      {/* Create new role action */}
      {customRolesEnabled && onCreateRole && <Divider />}
      {customRolesEnabled && onCreateRole && (
        <MenuItem value="__create_new_role__" sx={{ color: "primary.main" }}>
          <Iconify icon="mingcute:add-line" sx={{ mr: 1 }} />
          Create new role
        </MenuItem>
      )}
    </Select>
  );
}
