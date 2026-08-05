type LogoMarkProps = {
  className?: string
}

// Concentric layers around an ink core — the outer layer. Colors resolve
// through the token variables, so the mark re-inks itself per color scheme.
export function LogoMark({ className }: LogoMarkProps) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
      <rect x="6" y="6" width="88" height="88" rx="22" stroke="var(--am-primary-main)" strokeWidth="5" />
      <rect
        x="24"
        y="24"
        width="52"
        height="52"
        rx="14"
        stroke="var(--am-primary-dark)"
        strokeWidth="5"
        strokeOpacity="0.6"
      />
      <rect x="40" y="40" width="20" height="20" rx="6" fill="var(--am-text-primary)" />
    </svg>
  )
}
