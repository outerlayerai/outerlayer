"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslate } from "@outerlayer/locales";
import Iconify from "@/components/iconify";
import {
  buildScaffold,
  buildScopeKindPath,
  buildTargetedFilePath,
  nameError,
  pathExists,
  pathLengthErrorKey,
  scopeDirFor,
  type CreatableKind,
} from "../context-create";

export type { CreatableKind } from "../context-create";

/** A row action pre-targets the popover: `presetKind: null` opens the full menu locked to `scope`. */
export interface CreateFileTarget {
  scope: string;
  /** Directory shown in the location line and, for a preset kind, the dir the file lands in. */
  baseDir: string;
  presetKind: CreatableKind | null;
}

/** Menu order, icons, and copy follow the design's create menu. */
const KIND_OPTIONS: Array<{
  value: CreatableKind;
  labelKey: string;
  descriptionKey: string;
  icon: string;
}> = [
  { value: "command", labelKey: "dashboard.context.create.kinds.command.label", descriptionKey: "dashboard.context.create.kinds.command.description", icon: "mdi:console-line" },
  { value: "skill", labelKey: "dashboard.context.create.kinds.skill.label", descriptionKey: "dashboard.context.create.kinds.skill.description", icon: "mdi:star-four-points-outline" },
  { value: "subagent", labelKey: "dashboard.context.create.kinds.subagent.label", descriptionKey: "dashboard.context.create.kinds.subagent.description", icon: "mdi:robot-outline" },
  { value: "document", labelKey: "dashboard.context.create.kinds.document.label", descriptionKey: "dashboard.context.create.kinds.document.description", icon: "mdi:note-text-outline" },
  { value: "instructions", labelKey: "dashboard.context.create.kinds.instructions.label", descriptionKey: "dashboard.context.create.kinds.instructions.description", icon: "mdi:file-document-outline" },
  { value: "mcp", labelKey: "dashboard.context.create.kinds.mcp.label", descriptionKey: "dashboard.context.create.kinds.mcp.description", icon: "mdi:power-plug-outline" },
];

/** Kinds with a fixed filename — no naming step; one per scope. */
const FIXED_NAME_KINDS = new Set<CreatableKind>(["instructions", "mcp"]);
/** Kinds whose name may contain `/` to nest (commands into namespaces, documents into folders). */
const NESTABLE_KINDS = new Set<CreatableKind>(["command", "document"]);

/** The path a create lands at, given the mode: targeted (row action) appends to `baseDir`; menu uses the scope+kind shape. */
function pathFor(kind: CreatableKind, scope: string, name: string, target: CreateFileTarget | null): string {
  // A skill keeps its fixed `skills/<name>/SKILL.md` shape even from a row action
  // (the bare `skills/` dir), so it never appends `<baseDir>/<name>.md`.
  if (target && target.presetKind === kind && kind !== "skill") return buildTargetedFilePath(target.baseDir, name);
  return buildScopeKindPath(kind, scope, name);
}

/** Returns the i18n key of the name-validation error, or null when the name is valid. */
function nameErrorKey(kind: CreatableKind, name: string): string | null {
  if (FIXED_NAME_KINDS.has(kind)) return null;
  return nameError(name, {
    subagent: kind === "subagent",
    allowSlash: NESTABLE_KINDS.has(kind),
    maxLen: kind === "skill" ? 64 : undefined,
  });
}

export interface CreateFilePopoverProps {
  anchorEl: HTMLElement | null;
  /** Distinct `.outerlayer/` scope paths present in the tree (`""` = repo root). */
  scopes: string[];
  /** Every path that already exists (tree ∪ drafts) — duplicate detection. */
  existingPaths: ReadonlySet<string>;
  /** Row-action pre-target: locks the scope and pre-fills the location (and kind when set). */
  target?: CreateFileTarget | null;
  onCreate: (file: { path: string; content: string }) => void;
  onClose: () => void;
}

/**
 * Create menu anchored to the tree's `+` button or a directory row action. Step
 * one asks WHAT the file is (the context kinds, with plain-language
 * descriptions — the right directory and scaffold are automatic). Named kinds
 * advance to a naming step with a live path preview; fixed-filename kinds
 * (AGENTS.md, mcp.json) create immediately and are disabled where the scope
 * already has one. A row action pre-targets a directory (shown in a location
 * line) and, for a specific location, a preset kind. Creating stages a draft;
 * it publishes with the batch.
 */
export function CreateFilePopover({
  anchorEl,
  scopes,
  existingPaths,
  target = null,
  onCreate,
  onClose,
}: CreateFilePopoverProps) {
  const { t } = useTranslate();
  // A target locks the scope; otherwise the global `+` defaults to the repo root.
  const defaultScope = target ? target.scope : scopes.includes("") ? "" : (scopes[0] ?? "");
  const [kind, setKind] = useState<CreatableKind | null>(target?.presetKind ?? null);
  const [scope, setScope] = useState(defaultScope);
  const [name, setName] = useState("");
  // Scope is only selectable in the global menu with more than one scope.
  const multiScope = !target && scopes.length > 1;

  // The Popover stays mounted, so state must re-sync to the current target each
  // time it opens (a row action can preset a different kind/scope than the last).
  const open = anchorEl !== null;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setKind(target?.presetKind ?? null);
      setScope(defaultScope);
      setName("");
    }
    wasOpen.current = open;
  }, [open, target, defaultScope]);

  const reset = () => {
    setKind(target?.presetKind ?? null);
    setName("");
    setScope(defaultScope);
  };

  const close = () => {
    reset();
    onClose();
  };

  const create = (k: CreatableKind, s: string, n: string) => {
    onCreate({ path: pathFor(k, s, n, target), content: buildScaffold(k, n) });
    reset();
  };

  /** A fixed-name kind is one-per-scope; disabled where it already exists. */
  const fixedTaken = (k: CreatableKind, s: string) =>
    FIXED_NAME_KINDS.has(k) && existingPaths.has(buildScopeKindPath(k, s, ""));

  const pick = (k: CreatableKind) => {
    // Single-scope fixed-name kinds have nothing to ask — create immediately.
    if (FIXED_NAME_KINDS.has(k) && !multiScope) {
      create(k, defaultScope, "");
      return;
    }
    setKind(k);
  };

  const targetPath = useMemo(
    () => (kind ? pathFor(kind, scope, name.trim(), target) : ""),
    [kind, scope, name, target],
  );
  // Preview only: with an empty name, show a `<name>` placeholder segment rather
  // than the double slash a blank name would leave (`.outerlayer/skills//SKILL.md`).
  const previewPath = useMemo(
    () => (kind ? pathFor(kind, scope, name.trim() || "<name>", target) : ""),
    [kind, scope, name, target],
  );
  const nameIssueKey = kind ? nameErrorKey(kind, name.trim()) : null;
  // The full-path length cap can only be judged once the name is otherwise valid
  // (a per-segment failure is reported first, from nameError).
  const pathIssueKey =
    kind !== null && nameIssueKey === null ? pathLengthErrorKey(targetPath) : null;
  const issueKey = nameIssueKey ?? pathIssueKey;
  const duplicate =
    kind !== null &&
    issueKey === null &&
    (pathExists(targetPath, existingPaths) || fixedTaken(kind, scope));
  const canCreate = kind !== null && issueKey === null && !duplicate;

  /** Location line: the directory a create lands in — the target's baseDir, or the scope root. */
  const locationDir = target ? target.baseDir : scopeDirFor(scope);
  /** A back step is available only in the menu-driven mode (no preset kind to return to). */
  const canGoBack = target?.presetKind == null;

  return (
    <Popover
      open={anchorEl !== null}
      anchorEl={anchorEl}
      onClose={close}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      transformOrigin={{ vertical: -6, horizontal: "left" }}
      slotProps={{ paper: { sx: { width: 320, borderRadius: 1.5, p: 0.75 } } }}
      data-testid="create-file-popover"
    >
      {kind === null ? (
        <Stack>
          <Typography
            sx={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.7px",
              textTransform: "uppercase",
              color: "text.disabled",
              px: 1.25,
              pt: 1,
              pb: 0.5,
            }}
          >
            {t("dashboard.context.create.header")}
          </Typography>
          {KIND_OPTIONS.map((opt) => {
            const disabled = !multiScope && fixedTaken(opt.value, defaultScope);
            return (
              <Stack
                key={opt.value}
                component="button"
                type="button"
                direction="row"
                spacing={1.25}
                onClick={() => !disabled && pick(opt.value)}
                disabled={disabled}
                data-testid={`create-kind-${opt.value}`}
                sx={{
                  alignItems: "center",
                  textAlign: "left",
                  width: "100%",
                  border: 0,
                  bgcolor: "transparent",
                  px: 1.25,
                  py: 1,
                  borderRadius: 1,
                  cursor: disabled ? "default" : "pointer",
                  opacity: disabled ? 0.45 : 1,
                  "&:hover": disabled ? undefined : { bgcolor: "action.hover" },
                }}
              >
                <Box
                  sx={{
                    width: 30,
                    height: 30,
                    borderRadius: 1,
                    bgcolor: "action.hover",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Iconify icon={opt.icon} width={16} />
                </Box>
                <Stack sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.45 }}>{t(opt.labelKey)}</Typography>
                  <Typography
                    sx={{
                      fontSize: 12,
                      lineHeight: 1.4,
                      color: "text.disabled",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {disabled ? t("dashboard.context.create.alreadyExistsScope") : t(opt.descriptionKey)}
                  </Typography>
                </Stack>
              </Stack>
            );
          })}
        </Stack>
      ) : (
        <Stack spacing={1.25} sx={{ p: 1.25 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
            {canGoBack && (
              <IconButton size="small" onClick={() => setKind(null)} aria-label="Back" sx={{ p: 0.25 }}>
                <Iconify icon="mdi:arrow-left" width={16} />
              </IconButton>
            )}
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              {t("dashboard.context.create.newKindTitle", {
                kind: t(
                  KIND_OPTIONS.find((o) => o.value === kind)?.labelKey ?? "",
                ).toLowerCase(),
              })}
            </Typography>
          </Stack>

          {multiScope && (
            <TextField
              select
              label={t("dashboard.context.create.scope")}
              size="small"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              slotProps={{ htmlInput: { "data-testid": "create-scope-select" } }}
            >
              {scopes.map((s) => (
                <MenuItem key={s} value={s}>
                  {s === "" ? t("dashboard.context.repoRoot") : s}
                </MenuItem>
              ))}
            </TextField>
          )}

          {!FIXED_NAME_KINDS.has(kind) && (
            <TextField
              autoFocus
              label={t("dashboard.context.create.name")}
              size="small"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) create(kind, scope, name.trim());
              }}
              error={name.length > 0 && (issueKey !== null || duplicate)}
              helperText={
                name.length > 0
                  ? (issueKey
                      ? t(issueKey)
                      : duplicate
                        ? t("dashboard.context.create.dupPath")
                        : " ")
                  : " "
              }
              slotProps={{ htmlInput: { "data-testid": "create-name-input" } }}
            />
          )}

          {FIXED_NAME_KINDS.has(kind) && duplicate && (
            <Typography sx={{ fontSize: 12, color: "error.main" }} data-testid="create-fixed-taken">
              {kind === "mcp"
                ? t("dashboard.context.create.fixedTakenMcp")
                : t("dashboard.context.create.fixedTakenInstructions")}
            </Typography>
          )}

          <Stack spacing={0.25}>
            <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase", color: "text.disabled" }}>
              {t("dashboard.context.create.location")}
            </Typography>
            <Typography
              sx={{ fontFamily: "monospace", fontSize: 12, color: "text.secondary", wordBreak: "break-all" }}
              data-testid="create-location"
            >
              {locationDir}
            </Typography>
          </Stack>

          <Typography
            sx={{ fontFamily: "monospace", fontSize: 12, color: "text.secondary", wordBreak: "break-all" }}
            data-testid="create-path-preview"
          >
            {previewPath}
          </Typography>

          <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
            <Button size="small" onClick={close} data-testid="create-cancel">
              {t("dashboard.context.create.cancel")}
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => create(kind, scope, name.trim())}
              disabled={!canCreate}
              data-testid="create-submit"
            >
              {t("dashboard.context.create.create")}
            </Button>
          </Stack>
        </Stack>
      )}
    </Popover>
  );
}
