"use client";

import translationEn from "./langs/en.json";
import { init } from "@outerlayer/locales";

const i18n = init({ translations: { en: translationEn } });

export default i18n;