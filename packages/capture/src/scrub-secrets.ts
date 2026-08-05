// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Always-on secret scrubbing at the upload boundary.
 *
 * Content is the product (2026-07-15 decision: default tier = full), so the
 * cloud sees message text, thinking, and tool IO — which is exactly where
 * pasted credentials live. Scrubbing is therefore NOT a tier and NOT
 * configurable: every string that ships through `outerlayer sync` passes
 * through these patterns first, at every tier.
 *
 * Pattern philosophy: high precision over recall. Every pattern anchors on a
 * vendor-specific prefix or an unmistakable structure (PEM blocks, JWTs) so
 * ordinary prose and code never false-positive. A missed exotic token is
 * recoverable (revoke it); a product that mangles normal code is not.
 * Matches are replaced with `[REDACTED:<label>]` so the session still reads.
 */

interface SecretPattern {
  label: string;
  pattern: RegExp;
}

// Order matters only for overlapping families (PEM before generic). All
// patterns are global; `scrubText` runs each once over the input.
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // PEM private key blocks — replace the whole block, header to footer.
  {
    label: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { label: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // OpenAI / Anthropic / Stripe-style `sk-` and `sk_` families (covers
  // sk-ant-…, sk-proj-…, sk_live_…, sk_test_…, and our own sk_outerlayer_…).
  { label: "sk-token", pattern: /\bsk[-_][A-Za-z0-9_-]{16,}\b/g },
  { label: "stripe-restricted-key", pattern: /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: "github-fine-grained-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { label: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Contextual: an Authorization-style bearer value. The `bearer` keyword is
  // the anchor; short values (session words, "token") don't match.
  { label: "bearer-token", pattern: /\b([Bb]earer\s+)[A-Za-z0-9._~+/=-]{25,}\b/g },
  // More vendor families (gitleaks-informed).
  { label: "aws-secret-key", pattern: /\b(aws[_-]?secret[_-]?(?:access[_-]?)?key\W{0,5})[A-Za-z0-9/+=]{40}\b/gi },
  { label: "pypi-token", pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b/g },
  { label: "sendgrid-token", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { label: "twilio-key", pattern: /\bSK[0-9a-fA-F]{32}\b/g },
  { label: "fly-token", pattern: /\b(fo1_|fm1[ar]_|fm2_)[A-Za-z0-9_-]{20,}\b/g },
  { label: "vercel-token", pattern: /\bvc[a-z]?_[A-Za-z0-9]{24,}\b/g },
  { label: "supabase-service-key", pattern: /\bsbp_[A-Za-z0-9]{40,}\b/g },
  // Assignment-context catch-all for unknown vendors: a credential-ish
  // variable name assigned a non-trivial literal. The NAME is the anchor.
  {
    label: "assigned-secret",
    pattern: /\b((?:api[_-]?key|secret|token|passwd|password|credential|auth[_-]?key|access[_-]?key|private[_-]?key)s?["']?\s*(?:[:=]|=>)\s*["'])(?![\s"'])[^"'\n]{8,}(?=["'])/gi,
  },
  // Unquoted env-style lines (`cat .env` output): UPPER_SNAKE names that
  // contain a credential word. NODE_ENV / LOG_LEVEL never match.
  {
    label: "env-secret",
    pattern: /(^|\n)(\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(?!\$)["']?[^\s"'#]{6,}["']?/g,
  },
  // Basic-auth in ANY URL scheme (https clone URLs, ftp, etc.) — the
  // database-url rule above stays for its scheme-specific message clarity.
  { label: "url-basic-auth", pattern: /\b([a-z][a-z0-9+.-]{1,10}:\/\/[^\s:@\/]+:)[^\s@\/]{4,}(?=@)/g },
  // Secrets carried in URL query params (presigned URLs, token-in-URL).
  {
    label: "url-secret-param",
    pattern: /([?&](?:api_?key|token|access_token|auth|signature|sig|secret|key|X-Amz-Signature|X-Amz-Credential)=)[^&\s"'<>]{8,}/gi,
  },
  // Webhooks where the PATH is the credential.
  { label: "slack-webhook", pattern: /\bhooks\.slack\.com\/services\/[A-Za-z0-9+\/]{20,}/g },
  { label: "discord-webhook", pattern: /\bdiscord(?:app)?\.com\/api\/webhooks\/[0-9]{10,}\/[A-Za-z0-9_-]{30,}/g },
  // Session cookies in header dumps.
  { label: "cookie-header", pattern: /\b((?:Set-)?Cookie:\s*)[^\n]{16,}/gi },
];

// Payment card numbers: 13–19 digits (optionally spaced/dashed), validated
// with Luhn so ids/timestamps never match.
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function scrubCardNumbers(text: string): string {
  return text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    // Luhn alone still passes plenty of machine ids; require a card-brand
    // prefix (Visa/MC/Amex/Discover) so timestamps and ids never match.
    if (!/^(4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(digits)) return match;
    return luhnValid(digits) ? "[REDACTED:card-number]" : match;
  });
}

// ---------------------------------------------------------------------------
// Home-directory anonymization — the username IS identity.
// ---------------------------------------------------------------------------
// Seat attribution is anonymous by design, but every tool call carries paths
// like /Users/<name>/… — naming the developer in every row. Collapse the
// account segment of home-dir paths to `~` in everything that ships. Paths
// stay readable (~/Development/app/src/…); the person is gone.

// A leading delimiter (or start) anchors every home prefix, so `src/Users/x`
// (no delimiter before `/Users`) never matches. Kept a capture group so the
// delimiter survives the replacement.
const HOME_LEAD = "(^|[\\s\"'`=(:[])";
// A home path ends at a separator (either style), a closing quote/bracket, or
// end-of-string — never mid-segment, so `/rootkit` does not match `/root`.
const HOME_END = "(?=[\\\\/]|[\\s\"'`)\\],]|$)";
// Account/host/distro segment (usernames, UNC hosts, WSL distro names).
const HOME_SEG = "[A-Za-z0-9._-]+";
// Each alternative matches a home-dir prefix up to and including the account
// segment; the remainder rides the lookahead (never consumed), so its
// separator style is preserved on replacement (`C:\Users\jane\p` → `~\p`).
// Longest-first where one prefix contains another (`/var/home` before
// `/home`). Case-insensitive so Windows `Users`, WSL `wsl$`, and mixed-case
// variants all collapse.
const HOME_PREFIXES = [
  "[A-Za-z]:[\\\\/]Users[\\\\/]" + HOME_SEG, // Windows C:\Users\u | C:/Users/u
  "[A-Za-z]:[\\\\/]Documents and Settings[\\\\/]" + HOME_SEG, // legacy Windows
  "\\\\\\\\wsl\\$[\\\\/]" + HOME_SEG + "[\\\\/]home[\\\\/]" + HOME_SEG, // \\wsl$\distro\home\u
  "\\\\\\\\" + HOME_SEG + "[\\\\/]Users[\\\\/]" + HOME_SEG, // UNC \\host\Users\u
  "/mnt/[A-Za-z]/Users/" + HOME_SEG, // WSL /mnt/c/Users/u
  "/var/home/" + HOME_SEG, // ostree
  "/Users/" + HOME_SEG, // macOS
  "/home/" + HOME_SEG, // Linux
  "/root", // Linux root — no user segment
];

const HOME_PATH = new RegExp(
  HOME_LEAD + "(?:" + HOME_PREFIXES.join("|") + ")" + HOME_END,
  "gi",
);

function anonymizeHomePaths(text: string): string {
  return text.replace(HOME_PATH, (_m, lead: string) => `${lead}~`);
}

// ---------------------------------------------------------------------------
// Developer self-identity — the seat is anonymous, so the machine owner's
// name/email/hostname must not ride along in git-log output, shell prompts,
// or whoami results. Applied only to the LOCAL identity (provided by the
// caller at sync time) — other people's emails in fixtures stay readable.
// ---------------------------------------------------------------------------

export interface LocalIdentity {
  /** git config user.name — replaced with [DEV_NAME]. */
  name?: string;
  /** git config user.email — replaced with [DEV_EMAIL]. */
  email?: string;
  /** OS username (beyond the home path, e.g. whoami output, prompts). */
  username?: string;
  /** Hostname — replaced with [HOST]. */
  hostname?: string;
  /** Exact `os.homedir()` — collapsed to `~` in either separator style. Catches
   * a nonstandard $HOME the built-in shape patterns can't anticipate. */
  home?: string;
}

let localIdentity: Array<[RegExp, string]> = [];

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Repo-root prefix strip — an in-repo path renders repo-relative.
// ---------------------------------------------------------------------------
// A path under the session's working-tree root otherwise ships the whole
// ~/<parent-folders>/ chain. Strip an exact `repoRoot` + separator prefix
// (the root itself → "."). Runs BEFORE home substitution: the root sits under
// home, so the longer literal must match first. A plain prefix strip is
// deterministic and content-safe, so it applies to free text too, not only
// the structured cwd/file fields.
let repoRootPattern: RegExp | null = null;

/** Install the session's working-tree root (from `git rev-parse --show-toplevel`)
 * so `scrubText` strips it as a plain prefix. Cleared with a nullish root (a
 * session outside any repo). Matches both separator styles, case-insensitive;
 * an already-relative path carries no absolute root prefix, so it is a no-op. */
export function setRepoRoot(root: string | undefined): void {
  if (!root || root.trim().length < 2) {
    repoRootPattern = null;
    return;
  }
  const alts = escapeLiteral(root.trim()).replace(/\\\\|\//g, "[\\\\/]");
  // After the root: either a separator (captured → dropped with the prefix) or
  // a boundary (end/quote/space → the path IS the root → ".").
  repoRootPattern = new RegExp(`${HOME_LEAD}${alts}(?:([\\\\/])|(?=[\\s"'\`)\\],]|$))`, "gi");
}

function scrubRepoRoot(text: string): string {
  if (!repoRootPattern) return text;
  return text.replace(repoRootPattern, (_m, lead: string, sep?: string) => (sep ? lead : `${lead}.`));
}

/** Install the machine-local identity to scrub. Idempotent; sync calls it once. */
export function setLocalIdentity(identity: LocalIdentity): void {
  localIdentity = [];
  if (identity.home && identity.home.trim().length >= 3) {
    // Collapse the exact machine home prefix (either separator style) to `~`,
    // preserving the remainder. Pushed first so the full prefix becomes `~`
    // before the username rule can fragment it into `/x/[DEV_USER]/…`.
    const alts = escapeLiteral(identity.home.trim()).replace(/\\\\|\//g, "[\\\\/]");
    localIdentity.push([new RegExp(`${HOME_LEAD}${alts}${HOME_END}`, "gi"), "$1~"]);
  }
  if (identity.name && identity.name.trim().length >= 3) {
    localIdentity.push([new RegExp(escapeLiteral(identity.name.trim()), "g"), "[DEV_NAME]"]);
  }
  if (identity.email && identity.email.includes("@")) {
    localIdentity.push([new RegExp(escapeLiteral(identity.email.trim()), "gi"), "[DEV_EMAIL]"]);
  }
  if (identity.username && identity.username.length >= 4) {
    // Word-bounded, and >=4 chars so a common-word username ("sam", "dev")
    // can't shred ordinary prose. Longer real usernames dominate: measured
    // 7,321 hits on one corpus, mostly ENCODED paths (-Users-<name>-…) that
    // home-path anonymization cannot see.
    localIdentity.push([new RegExp(`\\b${escapeLiteral(identity.username)}\\b`, "g"), "[DEV_USER]"]);
  }
  if (identity.hostname && identity.hostname.length >= 4) {
    localIdentity.push([new RegExp(escapeLiteral(identity.hostname), "gi"), "[HOST]"]);
  }
}

function scrubLocalIdentity(text: string): string {
  let out = text;
  for (const [pattern, replacement] of localIdentity) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------------------
// Custom scrubbers — user-supplied, STRICTLY ADDITIVE.
// ---------------------------------------------------------------------------
// `scrub.literals` (exact strings: codenames, customer names, internal
// domains) and `scrub.patterns` ({label, pattern} regexes for org-specific
// token formats) in ~/.outerlayer/config.json widen the net. Built-ins can
// never be disabled or replaced — the init promise ("cannot be disabled")
// stays literally true. An invalid user regex is warned about and skipped;
// it never breaks a sync.

export interface CustomScrubConfig {
  literals?: string[];
  patterns?: Array<{ label?: string; pattern: string }>;
}

let customScrubbers: Array<[RegExp, string]> = [];

export function setCustomScrubbers(config: CustomScrubConfig | undefined, warn: (msg: string) => void = console.warn): void {
  customScrubbers = [];
  for (const literal of config?.literals ?? []) {
    if (typeof literal !== "string" || literal.trim().length < 3) continue;
    customScrubbers.push([new RegExp(escapeLiteral(literal.trim()), "gi"), "[REDACTED:custom]"]);
  }
  for (const entry of config?.patterns ?? []) {
    if (typeof entry?.pattern !== "string") continue;
    const label = typeof entry.label === "string" && /^[a-z0-9-]{1,32}$/i.test(entry.label) ? entry.label : "custom";
    try {
      customScrubbers.push([new RegExp(entry.pattern, "g"), `[REDACTED:${label}]`]);
    } catch (e) {
      warn(`[scrub] invalid custom pattern ${JSON.stringify(entry.pattern)} skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function scrubCustom(text: string): string {
  let out = text;
  for (const [pattern, replacement] of customScrubbers) out = out.replace(pattern, replacement);
  return out;
}

// NOTE: a bare high-entropy fallback was built and MEASURED against 323 real
// sessions: 46,925 hits (~145/session) — real transcripts are saturated with
// high-entropy ADDRESSES (cache-hash path segments, base64-ish ids in URLs),
// so it mangles content wholesale. Removed. Unknown-vendor coverage comes
// from the assignment-context rule (name-anchored) instead.

/** Scrub one string. Returns the input unchanged when nothing matches. */
export function scrubText(text: string): string {
  let out = text;
  for (const { label, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, keepPrefix?: string) =>
      typeof keepPrefix === "string" ? `${keepPrefix}[REDACTED:${label}]` : `[REDACTED:${label}]`,
    );
  }
  out = scrubCardNumbers(out);
  // Repo-root strip BEFORE home substitution — the root sits under home, so the
  // longer literal must win (`~/proj/app/x` would otherwise mask `.../x`).
  out = scrubRepoRoot(out);
  out = anonymizeHomePaths(out);
  out = scrubLocalIdentity(out);
  out = scrubCustom(out);
  return out;
}

/**
 * Deep-scrub every string value in a JSON-shaped object, in place.
 * Applied to the ENTIRE session before it enters a sync batch — titles,
 * turn text, thinking, tool call inputs/outputs, metadata, everything.
 * Precise vendor-anchored patterns make over-application harmless (a uuid,
 * path, or model id can't match), and scrubbing everything means a new
 * schema field can never silently become a leak path.
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrubText(value) as unknown as T;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i]);
    return value;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) record[key] = scrubDeep(record[key]);
    return value;
  }
  return value;
}
