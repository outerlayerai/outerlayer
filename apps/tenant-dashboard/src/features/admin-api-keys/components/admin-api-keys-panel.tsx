"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { Box, Stack } from "@mui/system";
import { useSnackbar } from "notistack";

import { SettingsSection } from "@/components/settings-shell";
import EmptyContent from "@/components/empty-content";
import { LocalDate } from "@/components/local-date";
import Iconify from "@/components/iconify";
import { useBoolean } from "@/hooks/use-boolean";
import { APP_PERMISSIONS } from "@repo/db-types/permissions";

import { createAdminApiKeyAction, revokeAdminApiKeyAction } from "../actions";
import type { AdminApiKeyRow } from "../types";

type Props = {
  initial: AdminApiKeyRow[];
};

/** Org-scoped bearer credentials for the admin REST API. Create/list/revoke; rotation is create + revoke. */
export const AdminApiKeysPanel = ({ initial }: Props) => {
  const { enqueueSnackbar } = useSnackbar();
  const [keys, setKeys] = useState(initial);
  const createDialog = useBoolean();
  const [name, setName] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [mintedSecret, setMintedSecret] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const resetCreateForm = () => {
    setName("");
    setSelectedPermissions([]);
    setMintedSecret(null);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await createAdminApiKeyAction({ name, permissions: selectedPermissions });
      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: "error" });
        return;
      }
      if (!result.data.ok) {
        enqueueSnackbar(result.data.message, { variant: "error" });
        return;
      }
      setMintedSecret(result.data.apiKey);
      // The list only carries metadata (never the secret) — a full reload
      // via server action isn't wired here, so the new row appears on next
      // navigation; the created secret itself is the immediate feedback.
    } catch {
      enqueueSnackbar("Something went wrong creating the key", { variant: "error" });
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      const result = await revokeAdminApiKeyAction({ id });
      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: "error" });
        return;
      }
      if (!result.data.ok) {
        enqueueSnackbar(result.data.message, { variant: "error" });
        return;
      }
      setKeys((prev) =>
        prev.map((k) => (k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k)),
      );
      enqueueSnackbar("Key revoked", { variant: "success" });
    } catch {
      enqueueSnackbar("Something went wrong revoking the key", { variant: "error" });
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <SettingsSection
      description="Bearer credentials for the admin REST API — member and role management from outside the dashboard. Create/revoke here; rotation is create a new key, then revoke the old one."
      footer={{
        action: (
          <Button variant="contained" onClick={createDialog.onTrue}>
            Create key
          </Button>
        ),
      }}
    >
      {keys.length === 0 ? (
        <EmptyContent title="No admin API keys yet" />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Key</TableCell>
              <TableCell>Permissions</TableCell>
              <TableCell>Last used</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {keys.map((key) => {
              const revoked = key.revoked_at !== null;
              const expired = key.expires_at !== null && new Date(key.expires_at) <= new Date();
              return (
                <TableRow key={key.id}>
                  <TableCell>{key.name}</TableCell>
                  <TableCell>
                    <code>{key.key_prefix ?? "—"}…</code>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.5 }}>
                      {key.permissions.map((p) => (
                        <Chip key={p} label={p} size="small" />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    {key.last_used_at ? <LocalDate value={key.last_used_at} /> : "Never"}
                  </TableCell>
                  <TableCell>
                    {revoked ? (
                      <Chip label="Revoked" size="small" color="error" />
                    ) : expired ? (
                      <Chip label="Expired" size="small" color="warning" />
                    ) : (
                      <Chip label="Active" size="small" color="success" />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Revoke">
                      <span>
                        <IconButton
                          disabled={revoked || revokingId === key.id}
                          onClick={() => handleRevoke(key.id)}
                        >
                          <Iconify icon="solar:trash-bin-trash-bold" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={createDialog.value}
        onClose={() => {
          createDialog.onFalse();
          resetCreateForm();
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Create admin API key</DialogTitle>
        <DialogContent>
          {mintedSecret ? (
            <Stack sx={{ gap: 2, pt: 1 }}>
              <Alert severity="warning">
                This secret is shown once. Copy it now — it cannot be retrieved again.
              </Alert>
              <TextField
                value={mintedSecret}
                slotProps={{ input: { readOnly: true } }}
                fullWidth
                multiline
              />
            </Stack>
          ) : (
            <Stack sx={{ gap: 2, pt: 1 }}>
              <TextField
                label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                fullWidth
                autoFocus
              />
              <TextField
                select
                label="Permissions"
                value={selectedPermissions}
                onChange={(e) =>
                  setSelectedPermissions(
                    typeof e.target.value === "string" ? e.target.value.split(",") : e.target.value,
                  )
                }
                slotProps={{ select: { multiple: true } }}
                fullWidth
              >
                {APP_PERMISSIONS.map((permission) => (
                  <MenuItem key={permission} value={permission}>
                    {permission}
                  </MenuItem>
                ))}
              </TextField>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                A key can only be granted permissions you currently hold.
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          {mintedSecret ? (
            <Button
              onClick={() => {
                createDialog.onFalse();
                resetCreateForm();
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button onClick={createDialog.onFalse}>Cancel</Button>
              <Button
                variant="contained"
                loading={creating}
                disabled={!name || selectedPermissions.length === 0}
                onClick={handleCreate}
              >
                Create
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
      <Box />
    </SettingsSection>
  );
};
