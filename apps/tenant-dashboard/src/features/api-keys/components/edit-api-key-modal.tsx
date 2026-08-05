"use client";

import {
  Typography,
  DialogTitle,
  DialogActions,
  Button,
  Dialog,
  DialogContent,
  Stack,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Chip,
  Box,
  FormHelperText,
} from "@mui/material";
import { useState, useCallback } from "react";
import { useSnackbar } from '@/components/snackbar';
import { updateApiKeyPermissionsAction } from "../actions";
import {
  GATEWAY_ROLES,
  GATEWAY_PERMISSIONS,
  PERMISSION_CATEGORIES,
  getPermissionsForRole,
} from "@/lib/gateway-permissions";

type Props = {
  open: boolean;
  onCloseAction: () => void;
  apiKeyId: string;
  appId: string;
};

export const EditApiKeyModal = ({ open, onCloseAction, apiKeyId, appId }: Props) => {
  const { enqueueSnackbar } = useSnackbar();

  const [selectedRole, setSelectedRole] = useState<string>("custom");
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [permissionError, setPermissionError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleRoleChange = useCallback((roleId: string) => {
    setSelectedRole(roleId);
    if (roleId !== "custom") {
      setSelectedPermissions(getPermissionsForRole(roleId));
    }
  }, []);

  const handlePermissionToggle = useCallback((permissionKey: string) => {
    setSelectedPermissions((prev) =>
      prev.includes(permissionKey)
        ? prev.filter((p) => p !== permissionKey)
        : [...prev, permissionKey]
    );
  }, []);

  const handleClose = () => {
    setSelectedRole("custom");
    setSelectedPermissions([]);
    setPermissionError("");
    onCloseAction();
  };

  const handleSubmit = async () => {
    if (selectedPermissions.length === 0) {
      setPermissionError("Select a role or at least one permission");
      return;
    }
    setPermissionError("");
    setIsSubmitting(true);

    try {
      const result = await updateApiKeyPermissionsAction({
        apiKeyId,
        appId,
        permissions: selectedPermissions,
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      if (!result.data.ok) {
        throw new Error(result.data.message);
      }
      enqueueSnackbar("Permissions updated successfully");
      handleClose();
    } catch (error: unknown) {
      enqueueSnackbar((error as Error).message, {
        variant: "error",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Edit API Key Permissions</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{
          pt: 1
        }}>
          <FormControl fullWidth>
            <InputLabel id="edit-role-select-label">Role</InputLabel>
            <Select
              labelId="edit-role-select-label"
              value={selectedRole}
              label="Role"
              onChange={(e) => handleRoleChange(e.target.value)}
            >
              {GATEWAY_ROLES.map((role) => (
                <MenuItem key={role.id} value={role.id}>
                  <Stack>
                    <Typography variant="body2">{role.label}</Typography>
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>
                      {role.description}
                    </Typography>
                  </Stack>
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {selectedRole === "custom" ? (
            <Box>
              {PERMISSION_CATEGORIES.map((category) => (
                <Box key={category} sx={{
                  mb: 1
                }}>
                  <Typography variant="subtitle2" gutterBottom>
                    {category}
                  </Typography>
                  <FormGroup>
                    {GATEWAY_PERMISSIONS.filter(
                      (p) => p.category === category
                    ).map((permission) => (
                      <FormControlLabel
                        key={permission.key}
                        control={
                          <Checkbox
                            size="small"
                            checked={selectedPermissions.includes(
                              permission.key
                            )}
                            onChange={() =>
                              handlePermissionToggle(permission.key)
                            }
                          />
                        }
                        label={
                          <Typography variant="body2">
                            {permission.label}
                          </Typography>
                        }
                      />
                    ))}
                  </FormGroup>
                </Box>
              ))}
              {permissionError && (
                <FormHelperText error>{permissionError}</FormHelperText>
              )}
            </Box>
          ) : (
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                gap: 0.5
              }}>
              {selectedPermissions.map((perm) => (
                <Chip key={perm} label={perm} size="small" />
              ))}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          loading={isSubmitting}
          onClick={handleSubmit}
          variant="contained"
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};
