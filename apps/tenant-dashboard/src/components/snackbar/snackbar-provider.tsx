"use client";

import React from "react";
import {
  closeSnackbar,
  SnackbarProvider as NotistackProvider,
} from "notistack";

import IconButton from "@mui/material/IconButton";

import Iconify from "@/components/iconify";

import { StyledIcon, StyledNotistack } from "./styles";

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
};

const VARIANT_ICON = {
  info: "eva:info-fill",
  success: "eva:checkmark-circle-2-fill",
  warning: "eva:alert-triangle-fill",
  error: "solar:danger-bold",
} as const;

export default function SnackbarProvider({ children }: Props) {
  return (
    <NotistackProvider
      maxSnack={5}
      preventDuplicate
      autoHideDuration={3000}
      // Optionless enqueues are success toasts by long-standing contract —
      // several live call sites pass only a message and rely on this default.
      variant="success"
      anchorOrigin={{ vertical: "top", horizontal: "right" }}
      iconVariant={{
        info: (
          <StyledIcon color="info">
            <Iconify icon={VARIANT_ICON.info} width={24} />
          </StyledIcon>
        ),
        success: (
          <StyledIcon color="success">
            <Iconify icon={VARIANT_ICON.success} width={24} />
          </StyledIcon>
        ),
        warning: (
          <StyledIcon color="warning">
            <Iconify icon={VARIANT_ICON.warning} width={24} />
          </StyledIcon>
        ),
        error: (
          <StyledIcon color="error">
            <Iconify icon={VARIANT_ICON.error} width={24} />
          </StyledIcon>
        ),
      }}
      Components={{
        default: StyledNotistack,
        info: StyledNotistack,
        success: StyledNotistack,
        warning: StyledNotistack,
        error: StyledNotistack,
      }}
      action={(snackbarId) => (
        <IconButton
          size="small"
          aria-label="Dismiss notification"
          onClick={() => closeSnackbar(snackbarId)}
          sx={{ p: 0.5 }}
        >
          <Iconify icon="mingcute:close-line" width={16} />
        </IconButton>
      )}
    >
      {children}
    </NotistackProvider>
  );
}
