import {
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
} from "@mui/material";
import Iconify from "@/components/iconify";
import { useState } from "react";

export const CopyableId = ({ label, id }: { label: string, id: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
    } catch (err) {
      console.error("Failed to copy: ", err);
    }
  };

  return (
    <TextField
      label={label}
      value={id}
      fullWidth
      variant="outlined"
      size="small"
      slotProps={{
        input: {
          readOnly: true,
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title={copied ? "Copied!" : "Copy to clipboard"}>
                <IconButton size="small" onClick={handleCopy} edge="end">
                  {copied ? (
                    <Iconify width={16} icon="ic:round-check-circle" />
                  ) : (
                    <Iconify width={16} icon="ic:round-content-copy" />
                  )}
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        }
      }}
    />
  );
};
