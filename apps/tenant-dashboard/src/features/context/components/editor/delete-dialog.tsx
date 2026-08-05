"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Typography,
} from "@mui/material";
import { Translation, useTranslate } from "@outerlayer/locales";
import { enumerateSkillDeletionAction } from "../../action-adapters";
import type { SkillDeletionEnumeration } from "./types";

export type DeleteTarget =
  | { kind: "file"; path: string; baseBlobSha: string; content: string }
  | { kind: "skill"; skillDir: string }
  | { kind: "dir"; dirPath: string };

/** One path staged for deletion — the conflict base, plus content for the diff when known. */
export interface StagedDeleteTarget {
  path: string;
  baseBlobSha: string;
  baseContent: string;
}

export interface DeleteContextDialogProps {
  open: boolean;
  appId: string;
  target: DeleteTarget;
  /** Stages every path in `target` for deletion — nothing commits here; publish lands it. */
  onStage: (targets: StagedDeleteTarget[]) => void;
  onClose: () => void;
}

/**
 * Delete confirmation. For a skill or generic directory it enumerates the
 * COMPLETE file set up front (`enumerateSkillDeletionAction`, `context.read`)
 * and lists every path, marking out-of-scope assets/scripts (`assetPaths`) so
 * the user is warned they will be marked too. Confirm STAGES every path as a
 * `delete` draft (the enumeration's freshly-read blob shas are the conflict
 * base) — nothing is committed until the batch publishes.
 */
export function DeleteContextDialog({
  open,
  appId,
  target,
  onStage,
  onClose,
}: DeleteContextDialogProps) {
  const { t } = useTranslate();
  const [enumeration, setEnumeration] = useState<SkillDeletionEnumeration | null>(
    null,
  );
  const [enumerating, setEnumerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enumerationDir = target.kind === "skill" ? target.skillDir : target.kind === "dir" ? target.dirPath : null;

  useEffect(() => {
    if (!open || enumerationDir === null) {
      setEnumeration(null);
      return;
    }
    let cancelled = false;
    setEnumerating(true);
    setError(null);
    enumerateSkillDeletionAction(appId, enumerationDir)
      .then((response) => {
        if (cancelled) return;
        if (response.error || !response.data) {
          setError(response.error ?? t("dashboard.context.delete.errorListFailed"));
          return;
        }
        const outcome = response.data;
        if (outcome.status === "ok") {
          setEnumeration(outcome.enumeration);
        } else if (outcome.status === "not_connected") {
          setError(t("dashboard.context.delete.errorNotConnected"));
        } else {
          setError(outcome.message);
        }
      })
      .finally(() => {
        if (!cancelled) setEnumerating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, appId, enumerationDir, t]);

  const handleConfirm = useCallback(() => {
    if (target.kind === "file") {
      onStage([{ path: target.path, baseBlobSha: target.baseBlobSha, baseContent: target.content }]);
    } else {
      // Bulk deletes stage by path alone — no per-file content fetch, so the
      // publish dialog shows these rows without a per-file diff/line count.
      const shas = enumeration?.shas ?? {};
      onStage(
        (enumeration?.paths ?? [])
          .filter((path) => shas[path] !== undefined)
          .map((path) => ({ path, baseBlobSha: shas[path]!, baseContent: "" })),
      );
    }
    onClose();
  }, [target, enumeration, onStage, onClose]);

  const assetSet = new Set(enumeration?.assetPaths ?? []);
  const title =
    target.kind === "skill"
      ? t("dashboard.context.delete.titleSkill")
      : target.kind === "dir"
        ? t("dashboard.context.delete.titleFolder")
        : t("dashboard.context.delete.titleFile");
  const confirmLabel =
    target.kind === "skill"
      ? t("dashboard.context.delete.deleteSkill")
      : target.kind === "dir"
        ? t("dashboard.context.delete.deleteFolder")
        : t("dashboard.context.delete.deleteFile");

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="delete-dialog">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {target.kind === "file" ? (
          <DialogContentText data-testid="delete-file-path">
            <Translation
              t={t}
              i18nKey="dashboard.context.delete.fileBody"
              values={{ path: target.path }}
              components={[<strong key="path" />]}
            />
          </DialogContentText>
        ) : (
          <>
            <DialogContentText>
              {target.kind === "skill"
                ? t("dashboard.context.delete.skillBody")
                : t("dashboard.context.delete.folderBody")}
            </DialogContentText>
            {enumerating && (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 2 }}>
                <CircularProgress size={18} />
                <Typography variant="body2">{t("dashboard.context.delete.listingFiles")}</Typography>
              </Box>
            )}
            {enumeration && (
              <Paper
                variant="outlined"
                sx={{
                  mt: 1.5,
                  p: 1.5,
                  maxHeight: 240,
                  overflowY: "auto",
                  fontFamily: "monospace",
                  fontSize: 13,
                  bgcolor: "background.neutral",
                }}
                data-testid="deletion-file-list"
              >
                {enumeration.paths.map((path) => {
                  const unmanaged = assetSet.has(path);
                  return (
                    <Box key={path} sx={{ py: 0.25 }} data-testid="deletion-file">
                      {path}
                      {unmanaged && (
                        <Typography
                          component="span"
                          variant="caption"
                          color="warning.main"
                          sx={{ fontFamily: "monospace" }}
                        >
                          {t("dashboard.context.delete.unmanagedMarker")}
                        </Typography>
                      )}
                    </Box>
                  );
                })}
              </Paper>
            )}
          </>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }} data-testid="delete-error">
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="delete-cancel">
          {t("dashboard.context.delete.cancel")}
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={handleConfirm}
          disabled={target.kind !== "file" && !enumeration}
          data-testid="delete-confirm"
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
