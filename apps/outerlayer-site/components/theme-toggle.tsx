"use client"

export function ThemeToggle() {
  function toggle() {
    const next = !document.documentElement.classList.contains("dark")
    document.documentElement.classList.toggle("dark", next)
    try {
      localStorage.setItem("ol-theme", next ? "dark" : "light")
    } catch {
      // Private-mode storage failures just lose persistence, not the toggle.
    }
  }

  // The visible icon is chosen by the `dark:` variant, so this component needs
  // no state and can't mismatch the class the pre-paint script applied.
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle color scheme"
      className="flex h-9 w-9 items-center justify-center rounded-control border border-rule text-ink-soft hover:text-ink"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 dark:hidden">
        <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z" strokeLinejoin="round" />
      </svg>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="hidden h-4 w-4 dark:block">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" strokeLinecap="round" />
      </svg>
    </button>
  )
}
