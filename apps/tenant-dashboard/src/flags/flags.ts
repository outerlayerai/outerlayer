import { createFeatureFlag } from "./flag-factory";

export const enableDarkMode = createFeatureFlag({
  key: "enable_dark_mode",
  defaultValue: false,
});
