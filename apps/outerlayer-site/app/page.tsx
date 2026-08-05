import { CompatBar, Hero, SiteFooter, SiteHeader } from "@/components/home/sections"

// Pre-launch waitlist page: one claim, the film, an email form, and the
// compatibility strip. The full landing-page sections still live in
// components/home/sections.tsx, unrendered until launch.
export default function HomePage() {
  return (
    <div className="relative flex min-h-dvh flex-col">
      {/* The drafting-sheet frame: two hairline verticals just outside the
          content grid, running the full page — visible at wide viewports. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 z-50 hidden w-px -translate-x-[600px] bg-rule xl:block"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 z-50 hidden w-px translate-x-[599px] bg-rule xl:block"
      />
      <SiteHeader />
      <main className="flex flex-1 flex-col justify-center">
        <Hero />
        <CompatBar />
      </main>
      <SiteFooter />
    </div>
  )
}
