"use client"

import { useState, type FormEvent } from "react"

type Status = "idle" | "loading" | "done" | "error"

export function WaitlistForm({ align = "start" }: { align?: "start" | "center" }) {
  const [email, setEmail] = useState("")
  const [status, setStatus] = useState<Status>("idle")
  const [message, setMessage] = useState("")

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (status === "loading") return
    setStatus("loading")
    const company = (new FormData(e.currentTarget).get("company") as string) ?? ""
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, company }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setStatus("error")
        setMessage(data.error ?? "Something went wrong. Try again in a minute.")
        return
      }
      setStatus("done")
    } catch {
      setStatus("error")
      setMessage("Something went wrong. Try again in a minute.")
    }
  }

  if (status === "done") {
    return (
      <p
        role="status"
        className={`font-mono text-sm text-success ${align === "center" ? "text-center" : ""}`}
      >
        ✓ You&apos;re on the list. We&apos;ll email you when it&apos;s your turn.
      </p>
    )
  }

  return (
    <form
      onSubmit={submit}
      className={`flex w-full max-w-md flex-col gap-2 ${align === "center" ? "mx-auto" : ""}`}
    >
      {/* Honeypot: humans never see this field; bots that fill it get a quiet no-op. */}
      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />
      <label htmlFor="waitlist-email" className="sr-only">
        Work email
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="waitlist-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          aria-invalid={status === "error"}
          aria-describedby={status === "error" ? "waitlist-error" : undefined}
          className="min-w-0 flex-1 rounded-control border border-rule bg-paper px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink-faint focus:outline-hidden"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="shrink-0 whitespace-nowrap rounded-control bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {status === "loading" ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
      {status === "error" && (
        <p
          id="waitlist-error"
          role="alert"
          className={`text-sm text-error ${align === "center" ? "text-center" : ""}`}
        >
          {message}
        </p>
      )}
    </form>
  )
}
