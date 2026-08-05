import Label from "@/components/label";
import Iconify from "@/components/iconify";
import { CircularProgress } from "@mui/material";
import type { WorkerRunStatus } from "../hooks";

type ChipConfig = {
  color: "success" | "error" | "info" | "warning" | "default";
  label: string;
  icon: React.ReactElement;
};

function deriveChipConfig(status: WorkerRunStatus): ChipConfig {
  switch (status) {
    case "queued":
      return { color: "default", label: "Queued", icon: <Iconify icon="eva:clock-outline" /> };
    case "provisioning":
      return { color: "info", label: "Provisioning", icon: <CircularProgress size={14} color="inherit" /> };
    case "running":
      return { color: "info", label: "Running", icon: <CircularProgress size={14} color="inherit" /> };
    case "pushing":
      return { color: "info", label: "Opening PR", icon: <CircularProgress size={14} color="inherit" /> };
    case "completed":
      return { color: "success", label: "Completed", icon: <Iconify icon="eva:checkmark-circle-2-fill" /> };
    case "failed":
      return { color: "error", label: "Failed", icon: <Iconify icon="eva:close-circle-fill" /> };
    case "cancelled":
      return { color: "default", label: "Cancelled", icon: <Iconify icon="eva:minus-circle-outline" /> };
    case "timed_out":
      return { color: "warning", label: "Timed out", icon: <Iconify icon="eva:clock-outline" /> };
    default:
      return { color: "default", label: status, icon: <Iconify icon="eva:question-mark-circle-outline" /> };
  }
}

export function WorkerRunStatusChip({ status }: { status: WorkerRunStatus }) {
  const config = deriveChipConfig(status);
  return (
    <Label color={config.color} startIcon={config.icon}>
      {config.label}
    </Label>
  );
}
