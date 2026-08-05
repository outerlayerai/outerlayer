"use client";

/**
 * Chat composer for the Workers section: a rounded input with
 * a send button, Enter to submit, Shift+Enter for a newline — the standard
 * AI-chat entry point. `controls` renders in the bottom bar (agent picker,
 * session toggle) so callers can compose their own option set.
 *
 * Supports file attachments (images, documents, data files): a paperclip in
 * the bottom bar opens the picker, selected files render as removable chips
 * above the input, and the caller receives them base64-encoded, ready for the
 * launch/turn API. Caps mirror the server contract in @repo/worker-core so
 * the user hears about an oversized file immediately instead of via a 400.
 */

import { useRef, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { Box, Chip, IconButton, InputBase, Paper, Tooltip } from "@mui/material";
import {
  MAX_WORKER_ATTACHMENTS,
  MAX_WORKER_ATTACHMENT_BYTES,
  MAX_WORKER_ATTACHMENT_TOTAL_BYTES,
  isAllowedWorkerAttachmentMime,
} from "@repo/worker-core";
import Iconify from "@/components/iconify";

/** A picked file, encoded and ready to ride in the launch/turn request. */
export interface ComposerAttachment {
  /** Client-side identity for removal (not sent to the server). */
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  /** File bytes, base64 (no data: URL prefix). */
  content: string;
}

/** Advisory picker list; the server enforces size and content type. */
const ATTACHMENT_ACCEPT =
  "image/*,.pdf,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.log,.patch,.diff,.docx,.xlsx";

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentIcon(mime: string): string {
  return mime.startsWith("image/") ? "eva:image-outline" : "eva:file-text-outline";
}

/** Read one picked file into a send-ready attachment (base64 via data URL). */
export function readFileAsAttachment(file: File): Promise<ComposerAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (!base64) {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }
      resolve({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        mime: file.type || "application/octet-stream",
        sizeBytes: file.size,
        content: base64,
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Apply the wire-contract caps to a prospective selection. Returns the files
 * that fit and the first human-readable reason anything was rejected.
 */
export function selectAttachmentFiles(
  existing: ComposerAttachment[],
  files: File[],
): { accepted: File[]; error: string | null } {
  const accepted: File[] = [];
  let error: string | null = null;
  let count = existing.length;
  let totalBytes = existing.reduce((acc, a) => acc + a.sizeBytes, 0);

  for (const file of files) {
    if (!isAllowedWorkerAttachmentMime(file.type || "application/octet-stream")) {
      error ??= `${file.name}: this file type is not supported.`;
      continue;
    }
    if (file.size > MAX_WORKER_ATTACHMENT_BYTES) {
      error ??= `${file.name} is larger than the ${formatAttachmentSize(MAX_WORKER_ATTACHMENT_BYTES)} per-file limit.`;
      continue;
    }
    if (count >= MAX_WORKER_ATTACHMENTS) {
      error ??= `You can attach at most ${MAX_WORKER_ATTACHMENTS} files.`;
      continue;
    }
    if (totalBytes + file.size > MAX_WORKER_ATTACHMENT_TOTAL_BYTES) {
      error ??= `Attachments are limited to ${formatAttachmentSize(MAX_WORKER_ATTACHMENT_TOTAL_BYTES)} in total.`;
      continue;
    }
    accepted.push(file);
    count += 1;
    totalBytes += file.size;
  }
  return { accepted, error };
}

interface WorkerComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  /** A turn is in flight — show the spinner and refuse submits. */
  busy?: boolean;
  /** The composer is not usable at all (e.g. the session has ended). */
  disabled?: boolean;
  autoFocus?: boolean;
  /** Rendered on the left of the bottom bar (agent picker, toggles, ...). */
  controls?: ReactNode;
  /** Current attachments; omit both attachment props to hide the paperclip. */
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (attachments: ComposerAttachment[]) => void;
  /** Surfaced when a picked file is rejected (over a cap, unreadable, ...). */
  onAttachmentError?: (message: string) => void;
}

export function WorkerComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  busy = false,
  disabled = false,
  autoFocus = false,
  controls,
  attachments = [],
  onAttachmentsChange,
  onAttachmentError,
}: WorkerComposerProps) {
  const canSubmit = !disabled && !busy && value.trim().length > 0;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  };

  const handleFilesPicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Reset so picking the same file again re-fires change.
    event.target.value = "";
    if (files.length === 0 || !onAttachmentsChange) return;

    const { accepted, error } = selectAttachmentFiles(attachments, files);
    if (error) onAttachmentError?.(error);
    if (accepted.length === 0) return;
    try {
      const read = await Promise.all(accepted.map(readFileAsAttachment));
      onAttachmentsChange([...attachments, ...read]);
    } catch (err) {
      onAttachmentError?.(err instanceof Error ? err.message : "Could not read the selected file.");
    }
  };

  const removeAttachment = (id: string) => {
    onAttachmentsChange?.(attachments.filter((a) => a.id !== id));
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        borderRadius: 3,
        bgcolor: "background.paper",
        "&:focus-within": { borderColor: "primary.main" },
      }}
    >
      {attachments.length > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mb: 1 }}>
          {attachments.map((attachment) => (
            <Chip
              key={attachment.id}
              size="small"
              variant="outlined"
              icon={<Iconify icon={attachmentIcon(attachment.mime)} width={16} />}
              label={`${attachment.name} · ${formatAttachmentSize(attachment.sizeBytes)}`}
              onDelete={disabled ? undefined : () => removeAttachment(attachment.id)}
              deleteIcon={
                // The label rides on a plain span: the SVG inside loads async
                // and can't be relied on to exist (or carry ARIA) at query time.
                <Box
                  component="span"
                  role="button"
                  aria-label={`Remove ${attachment.name}`}
                  sx={{ display: "inline-flex", alignItems: "center" }}
                >
                  <Iconify icon="eva:close-fill" width={16} />
                </Box>
              }
              sx={{ maxWidth: 280 }}
            />
          ))}
        </Box>
      )}
      <InputBase
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        multiline
        rows={2}
        fullWidth
        autoFocus={autoFocus}
        disabled={disabled}
        inputProps={{ "aria-label": placeholder }}
        sx={{ px: 0.5, typography: "body2" }}
      />
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", minWidth: 0 }}>
          {onAttachmentsChange && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept={ATTACHMENT_ACCEPT}
                onChange={handleFilesPicked}
                data-testid="worker-attachment-input"
              />
              <Tooltip title="Attach images or documents">
                <span>
                  <IconButton
                    size="small"
                    aria-label="Attach files"
                    disabled={disabled}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Iconify icon="eva:attach-2-outline" width={18} />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          )}
          {controls}
        </Box>
        <Box sx={{ flexGrow: 1 }} />
        <IconButton
          aria-label="Send"
          onClick={onSubmit}
          loading={busy}
          disabled={!canSubmit}
          sx={{
            bgcolor: "primary.main",
            color: "primary.contrastText",
            width: 34,
            height: 34,
            "&:hover": { bgcolor: "primary.dark" },
            "&.Mui-disabled": { bgcolor: "action.disabledBackground", color: "action.disabled" },
          }}
        >
          <Iconify icon="eva:arrow-upward-fill" width={18} />
        </IconButton>
      </Box>
    </Paper>
  );
}
