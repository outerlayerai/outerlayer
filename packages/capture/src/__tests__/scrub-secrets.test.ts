// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Always-on secret scrubbing (2026-07-15 decision). Contract:
 * every vendor-anchored credential family is replaced with a typed marker;
 * ordinary prose, code, uuids, and paths are untouched; scrubbing is
 * idempotent; deep-scrub reaches every string in a session-shaped object.
 */

import { describe, expect, it } from "vitest";
import { scrubText, scrubDeep } from "../scrub-secrets.js";

describe("scrubText", () => {
  const CASES: Array<[string, string, string]> = [
    ["aws access key id", "creds: AKIAIOSFODNN7EXAMPLE ok", "creds: [REDACTED:aws-access-key-id] ok"],
    ["openai/stripe sk token", "key sk_live_51AbCdEfGhIjKlMnOp end", "key [REDACTED:sk-token] end"],
    ["anthropic sk token", "use sk-ant-api03-AbCdEfGh1234567890 now", "use [REDACTED:sk-token] now"],
    ["our own key format", "sk_outerlayer_Fixture000000000000001", "[REDACTED:sk-token]"],
    ["github classic token", "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "[REDACTED:github-token]"],
    ["github fine-grained pat", "github_pat_11AAAAAAA0AAAAAAAAAAAA_x", "[REDACTED:github-fine-grained-pat]"],
    ["gitlab token", "glpat-AbCdEfGhIjKlMnOpQrSt", "[REDACTED:gitlab-token]"],
    ["slack token", "xoxb-1234567890-abcdefghij", "[REDACTED:slack-token]"],
    ["google api key", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "[REDACTED:google-api-key]"],
    ["npm token", "npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "[REDACTED:npm-token]"],
    [
      "jwt",
      "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpM done",
      "auth [REDACTED:jwt] done",
    ],
  ];

  it.each(CASES)("scrubs %s", (_name, input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("replaces an entire PEM private key block", () => {
    const pem = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nsecretlines\n-----END RSA PRIVATE KEY-----\nafter";
    expect(scrubText(pem)).toBe("before\n[REDACTED:private-key]\nafter");
  });

  it("keeps the Bearer keyword, scrubs only the token", () => {
    expect(scrubText("Authorization: Bearer abcDEF123456789012345678901234567")).toBe(
      "Authorization: Bearer [REDACTED:bearer-token]",
    );
  });

  it("leaves ordinary prose, code, uuids, and paths untouched", () => {
    const clean = [
      "fix the login bug in src/auth/verify-key.ts",
      "session 0af390d8-b5b8-4e30-81df-0b7f003fd206 had 42 turns",
      "const skip = true; // not a token",
      "the bearer of bad news", // short value after 'bearer' — no match
      "npm install left-pad",
    ].join("\n");
    expect(scrubText(clean)).toBe(clean);
  });

  it("is idempotent — scrubbing scrubbed text changes nothing", () => {
    const once = scrubText("key sk_live_51AbCdEfGhIjKlMnOp and AKIAIOSFODNN7EXAMPLE");
    expect(scrubText(once)).toBe(once);
  });
});

describe("scrubDeep", () => {
  it("reaches every string in a session-shaped object, in place", () => {
    const session = {
      id: "s1",
      title: "deploy with AKIAIOSFODNN7EXAMPLE",
      turns: [
        {
          text: "use sk_live_51AbCdEfGhIjKlMnOp",
          toolCalls: [{ name: "Bash", input: { command: "export GH=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }],
        },
      ],
      totals: { costUsd: 1.5 },
    };
    scrubDeep(session);
    expect(session.title).toBe("deploy with [REDACTED:aws-access-key-id]");
    expect(session.turns[0]!.text).toBe("use [REDACTED:sk-token]");
    expect(session.turns[0]!.toolCalls[0]!.input.command).toBe("export GH=[REDACTED:github-token]");
    expect(session.totals.costUsd).toBe(1.5);
    expect(session.id).toBe("s1");
  });
});

// ---------------------------------------------------------------------------
// hardened layers: assignment-context, entropy fallback, home anonymization
// ---------------------------------------------------------------------------

describe("scrubText — assignment-context catch-all", () => {
  it("scrubs credential-named assignments regardless of vendor format", () => {
    expect(scrubText('const API_KEY = "zq9xv7-totally-unknown-vendor-4218"')).toBe(
      'const API_KEY = "[REDACTED:assigned-secret]"',
    );
    expect(scrubText("password: 'hunter2hunter2'")).toBe("password: '[REDACTED:assigned-secret]'");
  });

  it("leaves non-credential assignments alone", () => {
    const clean = 'const filename = "report-2026-final-v2.pdf"; const color = "spring-green-500";';
    expect(scrubText(clean)).toBe(clean);
  });
});

describe("scrubText — no bare entropy heuristic (measured decision)", () => {
  it("leaves anchor-less high-entropy strings alone — addresses, hashes, ids", () => {
    // A bare entropy fallback fired ~145×/session on real transcripts
    // (cache-hash path segments, base64-ish URL ids). Unknown vendors are
    // covered by the assignment-context rule instead; a token with NO name
    // anchor and NO known prefix intentionally passes through.
    const clean = [
      "commit d6967b0e6a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "session 0af390d8-b5b8-4e30-81df-0b7f003fd206",
      "cache /nix/store/9fXk2Qw7Lz4Tn8Rv1Bs6Mj3Hd5Gp0Yc-pkg",
      `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUg".repeat(30)}`,
    ].join("\n");
    expect(scrubText(clean)).toBe(clean);
  });
});

describe("scrubText — home-directory anonymization", () => {
  it("collapses the account segment of home paths to ~", () => {
    expect(scrubText("Read /Users/devon/Development/app/src/index.ts")).toBe(
      "Read ~/Development/app/src/index.ts",
    );
    expect(scrubText("cwd=/home/mira11/work/repo")).toBe("cwd=~/work/repo");
  });

  it("anonymizes quoted paths and bare home dirs", () => {
    expect(scrubText('"file":"/Users/devon/notes.md"')).toBe('"file":"~/notes.md"');
    expect(scrubText("home is /Users/devon")).toBe("home is ~");
  });

  it("does not touch non-home paths", () => {
    const clean = "/etc/hosts and /var/log/system.log and src/Users/model.ts";
    expect(scrubText(clean)).toBe(clean);
  });

  it("collapses cross-OS home shapes, preserving the remainder + separator style", () => {
    const CASES: Array<[string, string]> = [
      // Windows, both separators, case-insensitive
      ["open C:\\Users\\jane\\p\\a.ts now", "open ~\\p\\a.ts now"],
      ["path C:/Users/jane/p/a.ts done", "path ~/p/a.ts done"],
      ["lower c:\\users\\jane\\r.md", "lower ~\\r.md"],
      // UNC and WSL
      ["unc \\\\SERVER\\Users\\bob\\x.txt end", "unc ~\\x.txt end"],
      ["wsl \\\\wsl$\\Ubuntu\\home\\amy\\r.md z", "wsl ~\\r.md z"],
      ["mnt /mnt/c/Users/carl/y.ts here", "mnt ~/y.ts here"],
      // Linux ostree + root
      ["ostree /var/home/dee/app/x", "ostree ~/app/x"],
      ["root /root/app/x and /root here", "root ~/app/x and ~ here"],
      // legacy Windows
      ["legacy C:\\Documents and Settings\\ed\\f.txt!", "legacy ~\\f.txt!"],
    ];
    for (const [input, expected] of CASES) {
      expect(scrubText(input), input).toBe(expected);
    }
  });

  it("does not over-collapse — /rootkit and /var/log are not home paths", () => {
    expect(scrubText("scan /rootkit/mod.ko and /var/log/app.log")).toBe("scan /rootkit/mod.ko and /var/log/app.log");
  });

  it("leaves no /Users/ or drive-Users prefix behind (leak pins)", () => {
    const out = scrubText("a /Users/mira/x b C:\\Users\\jane\\y c \\\\HOST\\Users\\bob\\z");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain(":\\Users\\");
    expect(out).not.toContain("\\Users\\");
  });

  it("is idempotent across every home shape", () => {
    const once = scrubText("C:\\Users\\jane\\x and /home/mira/y and /mnt/c/Users/carl/z");
    expect(scrubText(once)).toBe(once);
  });
});

describe("scrubText — connection strings", () => {
  it("scrubs the password segment of any basic-auth URL, keeping the rest", () => {
    expect(scrubText("postgres://admin:sup3rs3cret@db.internal:5432/prod")).toBe(
      "postgres://admin:[REDACTED:url-basic-auth]@db.internal:5432/prod",
    );
    expect(scrubText("git clone https://x-access-token:sometokenvalue123@github.com/acme/app")).toBe(
      "git clone https://x-access-token:[REDACTED:url-basic-auth]@github.com/acme/app",
    );
  });
});

// ---------------------------------------------------------------------------
// new layers: env lines, url params, webhooks, cards, identity, custom
// ---------------------------------------------------------------------------

import { setLocalIdentity, setCustomScrubbers, setRepoRoot } from "../scrub-secrets.js";
import { afterEach as afterEach2 } from "vitest";

afterEach2(() => {
  setLocalIdentity({});
  setCustomScrubbers(undefined);
  setRepoRoot(undefined);
});

describe("scrubText — env-style lines", () => {
  it("scrubs unquoted credential-named env assignments; benign env vars survive", () => {
    const env = "NODE_ENV=production\nexport STRIPE_WEBHOOK_SECRET=whsec_abc123def456\nLOG_LEVEL=debug";
    const out = scrubText(env);
    expect(out).toContain("NODE_ENV=production");
    expect(out).toContain("LOG_LEVEL=debug");
    expect(out).not.toContain("whsec_abc123def456");
    expect(out).toContain("[REDACTED:env-secret]");
  });
});

describe("scrubText — URLs and webhooks", () => {
  it("scrubs sensitive query params, keeps the rest of the URL", () => {
    const out = scrubText("GET https://s3.aws.com/bucket/file?X-Amz-Signature=abcdef1234567890&kind=report");
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain("kind=report");
  });

  it("scrubs slack webhook paths", () => {
    const out = scrubText("post to https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX");
    expect(out).toContain("[REDACTED:slack-webhook]");
  });
});

describe("scrubText — card numbers (Luhn + brand prefix)", () => {
  it("scrubs a valid visa number in any spacing", () => {
    expect(scrubText("pay with 4242 4242 4242 4242 please")).toBe("pay with [REDACTED:card-number] please");
  });

  it("leaves non-Luhn digit runs and timestamps alone", () => {
    const clean = "run 29368794225 finished at 1784090000000";
    expect(scrubText(clean)).toBe(clean);
  });
});

describe("scrubText — developer self-identity", () => {
  it("replaces the local git identity, username, and hostname", () => {
    setLocalIdentity({ name: "Devon Reyes", email: "devon@example.com", username: "devon", hostname: "Devons-MacBook-Pro.local" });
    const out = scrubText("Author: Devon Reyes <devon@example.com>\ndevon@Devons-MacBook-Pro.local ~ %");
    expect(out).toBe("Author: [DEV_NAME] <[DEV_EMAIL]>\n[DEV_USER]@[HOST] ~ %");
  });

  it("does not touch OTHER people's emails", () => {
    setLocalIdentity({ email: "devon@example.com" });
    expect(scrubText("fixture user demo@example.com stays")).toBe("fixture user demo@example.com stays");
  });

  it("collapses a nonstandard $HOME the shape patterns miss, in either separator style", () => {
    setLocalIdentity({ home: "/opt/homes/alice", username: "alice" });
    const out = scrubText("Read /opt/homes/alice/proj/main.ts");
    expect(out).toBe("Read ~/proj/main.ts");
    // The whole prefix collapses to `~` rather than fragmenting into [DEV_USER].
    expect(out).not.toContain("[DEV_USER]");
    expect(out).not.toContain("/opt/homes/alice");
  });

  it("collapses a Windows $HOME regardless of the separator used in the path", () => {
    setLocalIdentity({ home: "C:\\Users\\jane" });
    expect(scrubText("edit C:/Users/jane/proj/a.ts")).toBe("edit ~/proj/a.ts");
  });
});

describe("setRepoRoot — repo-relative prefix strip", () => {
  it("strips the repo-root prefix from paths (structured and in free text); root itself → '.'", () => {
    setRepoRoot("/Users/mira/manage-ai/app");
    expect(scrubText("edit /Users/mira/manage-ai/app/apps/x/y.ts now")).toBe("edit apps/x/y.ts now");
    expect(scrubText('"cwd":"/Users/mira/manage-ai/app"')).toBe('"cwd":"."');
    expect(scrubText("cd /Users/mira/manage-ai/app && ls")).toBe("cd . && ls");
  });

  it("matches both separator styles case-insensitively for a Windows root", () => {
    setRepoRoot("C:\\Users\\jane\\proj");
    expect(scrubText("open C:/Users/jane/proj/src/a.ts")).toBe("open src/a.ts");
    expect(scrubText("at C:\\Users\\jane\\proj done")).toBe("at . done");
  });

  it("leaves out-of-repo and already-relative paths untouched, and is idempotent", () => {
    setRepoRoot("/Users/mira/repo");
    expect(scrubText("apps/x/rel.ts")).toBe("apps/x/rel.ts");
    const once = scrubText("/Users/mira/repo/a and /Users/mira/repo");
    expect(once).toBe("a and .");
    expect(scrubText(once)).toBe(once);
  });

  it("runs before home substitution — a root under home is stripped, not collapsed to ~", () => {
    setRepoRoot("/Users/mira/manage-ai/app");
    // in-repo path → repo-relative; a sibling under home but outside the repo → ~
    expect(scrubText("in /Users/mira/manage-ai/app/src/a.ts vs /Users/mira/other/b.ts")).toBe(
      "in src/a.ts vs ~/other/b.ts",
    );
  });

  it("is cleared by a nullish root (a session outside any repo)", () => {
    setRepoRoot("/Users/mira/repo");
    setRepoRoot(undefined);
    expect(scrubText("path /Users/mira/repo/x.ts")).toBe("path ~/repo/x.ts");
  });
});

describe("setCustomScrubbers — strictly additive", () => {
  it("scrubs configured literals and patterns on top of built-ins", () => {
    setCustomScrubbers({
      literals: ["Project Bluebird"],
      patterns: [{ label: "acme-token", pattern: "ACME-[0-9]{6}" }],
    });
    const out = scrubText("Project Bluebird uses ACME-123456 and sk_live_51AbCdEfGhIjKlMnOp");
    expect(out).toBe("[REDACTED:custom] uses [REDACTED:acme-token] and [REDACTED:sk-token]");
  });

  it("skips an invalid regex with a warning and never throws", () => {
    const warnings: string[] = [];
    setCustomScrubbers({ patterns: [{ pattern: "([unclosed" }] }, (m) => warnings.push(m));
    expect(scrubText("plain text")).toBe("plain text");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("invalid custom pattern");
  });
});
