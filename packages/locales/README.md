To start using it do the following

1. Create i18n file e.g i18nInit
2. Initialize i18n by using the exported method init
3. Add translation files as param
4. import the created file (i18Init) to entry point of you app.

Note: Make sure you use "use client" at the top of file in your next app.

Exmaple

"use client";
import { init } from "@outerlayer/locales";
import translationEn from "./langs/en.json";

init({ translations: { en: translationEn } });
