import { ImageResponse } from "next/og"

import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site"

export const alt = `${SITE_NAME} — the open-source platform for coding-agent fleets`
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

// Pinned hex, not the --am-* variables: Satori resolves no CSS custom
// properties, and a social card has one fixed light rendering anyway. Values
// track the light scheme in @repo/design-tokens; #FF9800 is the marker, which
// is pinned everywhere by brand rule.
const PAPER = "#FAFAF9"
const INK = "#1A1A18"
const INK_SOFT = "#5C5C55"
const RULE = "#E7E7E3"
const BRAND = "#2065D1"
const BRAND_DARK = "#1A55B8"
const MARKER = "#FF9800"

/**
 * Fetches a Geist cut from Google Fonts so the card carries the brand face.
 * Returns null on any failure — Satori then falls back to its bundled face,
 * which is a duller card but never a failed deploy.
 */
async function geist(weight: number): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=Geist:wght@${weight}`).then((r) => r.text())
    const url = css.match(/src: url\((.+?)\)/)?.[1]
    if (!url) return null
    return await fetch(url).then((r) => r.arrayBuffer())
  } catch {
    return null
  }
}

export default async function OpengraphImage() {
  const [regular, semibold] = await Promise.all([geist(400), geist(600)])
  const fonts = [
    regular && { name: "Geist", data: regular, weight: 400 as const, style: "normal" as const },
    semibold && { name: "Geist", data: semibold, weight: 600 as const, style: "normal" as const },
  ].filter((f) => f !== null)

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          color: INK,
          fontFamily: fonts.length > 0 ? "Geist" : undefined,
          padding: "64px 72px",
        }}
      >
        {/* Masthead: the concentric-layers mark + the lowercase wordmark. */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <svg width="52" height="52" viewBox="0 0 100 100" fill="none">
            <rect x="6" y="6" width="88" height="88" rx="22" stroke={BRAND} strokeWidth="5" />
            <rect x="24" y="24" width="52" height="52" rx="14" stroke={BRAND_DARK} strokeWidth="5" strokeOpacity="0.6" />
            <rect x="40" y="40" width="20" height="20" rx="6" fill={INK} />
          </svg>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>
            <span style={{ color: INK }}>outer</span>
            <span style={{ color: INK_SOFT }}>layer</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 20, letterSpacing: "0.08em", color: BRAND, textTransform: "uppercase" }}>
            Open source · Agentic engineering
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 24, fontSize: 68, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
            <div style={{ display: "flex" }}>The open-source platform</div>
            {/* The one marker swipe the card is allowed — over the words that
                carry the category claim. */}
            <div style={{ display: "flex", marginTop: 8 }}>
              <div style={{ display: "flex", background: MARKER, color: INK, padding: "2px 10px" }}>for coding-agent fleets.</div>
            </div>
          </div>
          <div style={{ display: "flex", marginTop: 32, fontSize: 26, lineHeight: 1.4, color: INK_SOFT, maxWidth: 940 }}>
            {SITE_DESCRIPTION.split(" — ")[0]}.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", height: 1, background: RULE }} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, fontSize: 22, color: INK_SOFT }}>
            <div style={{ display: "flex" }}>outerlayer.ai</div>
            <div style={{ display: "flex" }}>hello@outerlayer.ai</div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: fonts.length > 0 ? fonts : undefined },
  )
}
