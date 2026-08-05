"use client";

import { AdapterDateFns } from "@mui/x-date-pickers/AdapterDateFns";
import { LocalizationProvider as MuiLocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";

import { useLocales } from "./use-locales";
import React from "react";
import { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
  i18n: i18n;
};

export default function LocalizationProvider({ children, i18n }: Props) {
  const { currentLang } = useLocales();

  return (
    <I18nextProvider i18n={i18n}>
      <MuiLocalizationProvider
        dateAdapter={AdapterDateFns}
        adapterLocale={currentLang!.adapterLocale}
      >
        {children}
      </MuiLocalizationProvider>
    </I18nextProvider>
  );
}
