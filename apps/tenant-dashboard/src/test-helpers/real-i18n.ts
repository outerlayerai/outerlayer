import type { ReactNode } from "react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/langs/en.json";

/**
 * The real i18next singleton, booted once with the real en.json under the same
 * config the shipped package uses (namespace `translations`, no HTML escaping).
 * Lets a test resolve a translation key + interpolation params to the exact copy
 * the UI renders — proving the key exists and its placeholders line up.
 */
export function getRealI18n() {
  if (!i18next.isInitialized) {
    i18next.use(initReactI18next).init({
      resources: { en: { translations: en } },
      lng: "en",
      fallbackLng: "en",
      ns: ["translations"],
      defaultNS: "translations",
      interpolation: { escapeValue: false },
    });
  }
  return i18next;
}

/**
 * Opt-in replacement for the globally-stubbed `@outerlayer/locales`. The global
 * unit setup echoes translation keys back; a component test that asserts on
 * rendered English needs the real hook plus the real en.json instead.
 *
 * It rebuilds the module's surface (`useTranslate`, `Translation`,
 * `LocalizationProvider`) straight from `react-i18next`/`i18next`, rather than
 * un-mocking the real package — whose barrel drags in `@mui/x-data-grid/locales`,
 * a subpath the test stub can't resolve. Call from a per-file `vi.mock` factory.
 */
export async function realLocalesModule() {
  const { useTranslation, Trans } = await import("react-i18next");
  const i18n = getRealI18n();
  return {
    useTranslate: () => {
      const { t, i18n: instance, ready } = useTranslation();
      return { t, i18n: instance, ready };
    },
    Translation: Trans,
    LocalizationProvider: ({ children }: { children?: ReactNode }) => children,
    init: () => i18n,
    i18n,
  };
}
