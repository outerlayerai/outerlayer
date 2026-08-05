import { NextResponse } from "next/server"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Signups land in the Resend contact list that launch emails send from, so
// there is no separate database to keep in sync.
export async function POST(req: Request) {
  let body: { email?: string; company?: string }
  try {
    body = (await req.json()) as { email?: string; company?: string }
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }

  // Honeypot field filled → almost certainly a bot. Pretend success.
  if (body.company) return NextResponse.json({ ok: true })

  const email = (body.email ?? "").trim().toLowerCase()
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 })
  }

  // Contacts are account-global, so the key alone identifies the list. It must
  // be a full-access key: a sending-only key is rejected as restricted_api_key.
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.error("waitlist: RESEND_API_KEY not set")
    return NextResponse.json(
      { error: "Signups are paused right now. Email hello@outerlayer.ai and we'll add you." },
      { status: 503 },
    )
  }

  const res = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, unsubscribed: false }),
  })

  // Someone signing up twice is not a failure from their side, so a conflict on
  // an address already in the list counts as success.
  if (!res.ok && res.status !== 409) {
    console.error("waitlist: resend responded", res.status, await res.text())
    return NextResponse.json(
      { error: "Something went wrong. Try again in a minute." },
      { status: 502 },
    )
  }

  return NextResponse.json({ ok: true })
}
