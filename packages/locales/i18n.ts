"use client";

import i18n from "i18next";
import { initReactI18next,  Trans } from "react-i18next";

import { defaultLang } from "./config-lang";

// ----------------------------------------------------------------------

// The app ships a single language, so pin the initial language to a constant
// instead of deriving it from localStorage or a browser language detector.
// Those sources don't exist during a server render: the server resolved an
// `undefined` language and rendered translation keys, while the client
// resolved "en" and rendered real text — a React #418 text hydration mismatch
// on every translated page. A constant makes the server and the first client
// render produce byte-identical text.
const lng = defaultLang!.value;

type ConfigProps = {
  translations: {
    en: {
      [x: string]:
        | string
        | {
            [key: string]: any;
          };
    };
  };
};

export function init({ translations }: ConfigProps) {
  i18n
    .use(initReactI18next)
    .init({
      resources: {
        en: { translations: translations.en },
      },
      lng,
      fallbackLng: lng,
      debug: false,
      ns: ["translations"],
      defaultNS: "translations",
      interpolation: {
        escapeValue: false,
      },
    });
  return i18n;
}

export default i18n;

export const Translation: typeof Trans = Trans;
