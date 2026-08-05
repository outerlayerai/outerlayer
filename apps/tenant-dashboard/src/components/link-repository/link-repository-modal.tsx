"use client";

import {
  Autocomplete,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField, Button } from "@mui/material";
import { useState, useEffect } from "react";
import {
  fetchBranchesForRepository,
  fetchRepositoriesForApp,
  linkRepositoryAction,
} from "@/features/apps/actions";
import { debounce } from "lodash";
import { Stack } from "@mui/system";
import { useTranslate } from "@outerlayer/locales";

type Props = {
  appId: string;
  open: boolean;
  onClose: () => void;
  translationPrefix?: string;
};

export const LinkRepositoryModal = ({
  appId,
  open,
  onClose,
  translationPrefix = "app",
}: Props) => {
  const [saving, setSaving] = useState(false);
  const [repository, setRepository] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>("");
  const [branchError, setBranchError] = useState<string>("");
  const [repositories, setRepositories] = useState<string[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);

  const { t: translate } = useTranslate();
  const t = (key: string) =>
    translate(`${translationPrefix}.linkRepositoryModal.${key}`);

  // Fetch repositories when modal opens
  useEffect(() => {
    if (open && appId && repositories.length === 0) {
      setLoadingRepos(true);
      fetchRepositoriesForApp({ appId })
        .then((result) => {
          if (!result.ok) {
            setError(result.error.message);
          } else if (!result.data.ok) {
            setError(result.data.message);
          } else {
            setRepositories(result.data.repositories);
          }
        })
        .catch((err) => {
          setError(err.message);
        })
        .finally(() => {
          setLoadingRepos(false);
        });
    }
  }, [open, appId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await linkRepositoryAction({ appId, repository, branch: selectedBranch });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (!result.data.ok) {
        setError(result.data.message);
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleRepoChange = async (repository: string) => {
    setBranches([]);
    setRepository(repository);
    debounce(async () => {
      const result = await fetchBranchesForRepository({ appId, repository });
      if (!result.ok) {
        setBranchError(result.error.message);
        return;
      }
      if (!result.data.ok) {
        setBranchError(result.data.message);
        return;
      }
      setBranches(result.data.branches);
    }, 200)();
  };

  return (
    <Dialog
      fullWidth
      open={open}
      onClose={() => {
        onClose();
        setError("");
        setRepository("");
        setRepositories([]);
        setBranches([]);
        setSelectedBranch("");
      }}
    >
      <DialogTitle>{t("title")}</DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          <Autocomplete
            sx={{ mt: 1 }}
            loading={loadingRepos}
            options={repositories}
            onChange={(_, value) => {
              handleRepoChange(value || "");
              setError("");
              setBranchError("");
            }}
            value={repository}
            renderInput={(params) => (
              <TextField
                error={Boolean(error)}
                helperText={error}
                {...params}
                label={t("selectLabel")}
              />
            )}
          />
          <Autocomplete
            loading={!!repository && !branches.length}
            sx={{ mt: 1 }}
            options={branches}
            onChange={(_, value) => {
              setSelectedBranch(value || "");
              setBranchError("");
            }}
            renderInput={(params) => (
              <TextField
                error={Boolean(branchError)}
                helperText={branchError}
                {...params}
                label={t("branchLabel")}
              />
            )}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          disabled={!repository || !selectedBranch}
          onClick={handleSave}
          loading={saving}
        >
          {t("saveButton")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
