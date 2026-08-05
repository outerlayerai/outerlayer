import { Geist, JetBrains_Mono } from "next/font/google";

// ----------------------------------------------------------------------
// UI face: Geist. Code/ids: JetBrains Mono. Both OFL, self-hosted at build
// via next/font/google (no runtime fetch, no FOUT). Weights are the set the
// type scale + component overrides actually render (regular → semibold).

export const geist = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  fallback: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Roboto",
    "sans-serif",
  ],
});

export const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

export const primaryFont = geist.style.fontFamily;
export const monoFont = jetBrainsMono.style.fontFamily;
