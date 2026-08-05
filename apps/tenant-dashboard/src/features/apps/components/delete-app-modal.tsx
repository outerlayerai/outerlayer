import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from "@mui/material";
import { useRef, useState } from "react";
import { useSnackbar } from "notistack";
import { deleteAppAction } from "../actions";

type Props = {
  appId: string;
  open: boolean;
  onClose: () => void;
  t: (key: string) => string;
  appName: string;
};

/**
 * One `deleteAppAction` call: the gateway DELETE removes the `app` row (DB
 * cascade handles every child table — git_connection, git_branch,
 * env_webhook, slack_integration, and so on),
 * then the action sweeps the app's `api_key` rows server-side — deleting a
 * row is the revocation (its digest cascades), so this is a Postgres-only
 * cleanup step, not an external provider call.
 */
export const DeleteAppModal = ({ open, onClose, appId, t, appName }: Props) => {
  const [deleting, setDeleting] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  // Ref guard against double-fire. The Button's `loading` prop shows a
  // spinner, but a fast second click can land before React re-renders it
  // disabled — without this guard that fires the delete action twice.
  const inFlight = useRef(false);
  const { enqueueSnackbar } = useSnackbar();

  const handleClose = () => {
    setDeleteText('');
    onClose();
  };

  const handleDelete = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    try {
      const result = await deleteAppAction({ appId });
      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: "error" });
        return;
      }
      if (!result.data.ok) {
        if (result.data.errorCode === "api_key_sweep_failed") {
          // The app row is already gone — non-fatal, but surface it so the
          // user can notice + retry the sweep.
          enqueueSnackbar(t("deleteAppSuccess"), { variant: "success" });
          enqueueSnackbar(result.data.message, { variant: "warning" });
          handleClose();
          return;
        }
        enqueueSnackbar(t("deleteAppFailed"), { variant: "error" });
        return;
      }

      enqueueSnackbar(t("deleteAppSuccess"), { variant: "success" });
      handleClose();
    } finally {
      setDeleting(false);
      inFlight.current = false;
    }
  };

  return (
    <Dialog fullWidth open={open} onClose={handleClose}>
      <DialogTitle>{t("deleteDialogTitle")}</DialogTitle>
      <DialogContent sx={{ mb: 2 }}>{t("deleteAppDescription")}</DialogContent>
      <DialogContent>{t("enterAppNameToDelete")}</DialogContent>
      <TextField
        value={deleteText}
        sx={{ px: 2 }}
        onChange={(event) => setDeleteText(event.target.value)}
      />
      <DialogActions>
        <Button onClick={handleClose}>{t("cancel")}</Button>
        <Button
          variant="contained"
          color="error"
          loading={deleting}
          disabled={appName !== deleteText}
          onClick={handleDelete}
        >
          {t("deleteButton")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
