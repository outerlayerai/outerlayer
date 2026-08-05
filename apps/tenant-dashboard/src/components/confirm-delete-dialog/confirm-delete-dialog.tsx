"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";

// ----------------------------------------------------------------------

type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
  title: string;
  /** The exact text the user must type before the destructive action unlocks. */
  confirmationText: string;
  /** Destructive button label (default "Delete"). */
  confirmLabel?: string;
  /** Context shown above the type-to-confirm field (warnings, fallback pickers). */
  children?: React.ReactNode;
};

/**
 * A type-to-confirm delete dialog: the destructive button stays disabled until
 * the user types `confirmationText` back exactly (mirroring DeleteEnvDialog).
 * Shared by the custom-role and SSO-config deletes so the gate lives — and is
 * tested — in one place.
 */
export function ConfirmDeleteDialog({
  open,
  onClose,
  onConfirm,
  loading = false,
  title,
  confirmationText,
  confirmLabel = "Delete",
  children,
}: Props) {
  const [value, setValue] = useState("");

  // Clear the field whenever the dialog toggles, so a reopen never starts armed.
  useEffect(() => {
    setValue("");
  }, [open, confirmationText]);

  const confirmed = value.trim() === confirmationText.trim() && confirmationText.length > 0;

  return (
    <Dialog open={open} onClose={() => !loading && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {children}
          <TextField
            size="small"
            label={`Type "${confirmationText}" to confirm`}
            placeholder={confirmationText}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            autoFocus
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading} color="inherit">
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          loading={loading}
          onClick={onConfirm}
          disabled={!confirmed}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
