import type { ReactNode } from "react"

import { LogoMark } from "@/components/logo-mark"
import { ThemeToggle } from "@/components/theme-toggle"

import {
  ClaudeLogo,
  CopilotLogo,
  CursorLogo,
  GeminiLogo,
  OpenAILogo,
  OpenCodeLogo,
} from "./agent-logos"
import { HeroVideo } from "./hero-video"
import { WaitlistForm } from "./waitlist-form"

function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-6xl px-6 ${className}`}>{children}</div>
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-brand">
      {children}
    </p>
  )
}

/* ── header ─────────────────────────────────────────────────────────── */

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-canvas">
      <Container className="flex h-16 items-center justify-between">
        <a href="#top" className="flex items-center gap-2.5">
          <LogoMark className="h-7 w-7" />
          <span className="text-[17px] font-semibold tracking-tight">
            outer<span className="text-ink-soft">layer</span>
          </span>
        </a>
        <ThemeToggle />
      </Container>
    </header>
  )
}

/* ── hero ───────────────────────────────────────────────────────────── */

export function Hero() {
  return (
    <section id="top" className="bg-paper">
      <Container className="grid items-center gap-12 py-10 lg:grid-cols-[1fr_1.05fr]">
        <div className="min-w-0">
          <Eyebrow>Open source</Eyebrow>
          <h1 className="text-balance text-display2 xl:text-display1">
            The <span className="mark-ol">evidence layer</span> for coding
            agents.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-soft">
            Outerlayer is an open-source platform for coding-agent fleets. It
            traces every agent session, ties it to the pull request it
            produced, and shows what merged, what got reverted, and what it
            cost — then points you at the few mistakes worth fixing.
          </p>
          <div className="mt-9">
            <WaitlistForm />
          </div>
          <p className="mt-5 font-mono text-xs text-ink-soft">
            Works from your first Claude Code session
          </p>
        </div>
        <div className="min-w-0">
          <HeroVideo />
        </div>
      </Container>
    </section>
  )
}

/* ── compatibility bar ──────────────────────────────────────────────── */

const AGENTS = [
  { name: "Claude Code", Logo: ClaudeLogo },
  { name: "Codex CLI", Logo: OpenAILogo },
  { name: "Cursor", Logo: CursorLogo },
  { name: "Gemini CLI", Logo: GeminiLogo },
  { name: "Copilot", Logo: CopilotLogo },
  { name: "OpenCode", Logo: OpenCodeLogo },
]

export function CompatBar() {
  return (
    <section aria-label="Compatibility">
      <Container className="flex flex-col items-center gap-3 py-5 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.08em] text-ink-faint">
          Works with the agents you already run
        </p>
        <ul className="flex flex-wrap items-center justify-center gap-2.5">
          {AGENTS.map(({ name, Logo }) => (
            <li
              key={name}
              className="flex items-center gap-2 rounded-chip border border-rule bg-paper px-3.5 py-1.5 font-mono text-[13px] text-ink-soft"
            >
              <Logo className="h-4 w-4 shrink-0" />
              {name}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-rule">
      <Container className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <LogoMark className="h-5 w-5" />
          <span className="font-medium text-ink">
            outer<span className="text-ink-soft">layer</span>
          </span>
        </div>
        <a
          href="mailto:hello@outerlayer.ai"
          className="font-mono text-xs text-ink-faint transition-colors hover:text-ink-soft"
        >
          hello@outerlayer.ai
        </a>
      </Container>
    </footer>
  )
}
