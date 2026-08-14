---
name: emitting-evidence
description: >
  Emit artifacts — screenshots, recordings, reports, logs — as proof that a
  change works, bound to the pull request via `outerlayer emit artifact`.
  Use when finishing work on an acceptance criterion, when a criterion
  declares a required proof form (e.g. "proof: video"), when asked to
  "provide evidence", "attach a screenshot", or "prove it works", and in CI
  steps that produce verifiable output.
---

An artifact is an exhibit: evidence *of* a specific change, anchored to the
pull request and rendered in its evidence comment. Emit the few exhibits the
spec asks for — a reviewer should see the change working, not a gallery.

## When to capture

Capture AFTER the state exists, never before: run the app, the test, or the
flow first, and shoot the working result. A screenshot of code is not
evidence; a screenshot of the rendered page is. If the state takes setup
(seed data, a logged-in user), finish the setup, verify by eye, then capture.

## Per-kind mechanics

Kind is inferred from the file's media type — name files honestly. Every
artifact shares one upload cap of 8 MiB, whatever its kind:

- **screenshot** (`.png`, `.jpg`) — one focused window or region showing the
  proven state. Crop noise; keep enough chrome (URL bar, test summary line)
  to show it is real.
- **video** (`.webm`, `.mp4`) — a short recording of the flow, start to
  outcome. Video is the kind most likely to hit the 8 MiB cap: trim dead
  time, prefer webm.
- **report** (`.html`, `.pdf`) — generated reports: coverage, benchmark,
  audit output. Emit the file the tool produced, unedited.
- **log** (`.txt`, `.log`) — command output proving a run happened: test
  runs, migrations, gate output. Pipe to a file and emit that file.

Anything else uploads as plain `file` — it is never guessed into a stronger
kind, so a `.mov` will NOT count where a video is required; convert first.

## Captions

One sentence, present tense, saying what the exhibit shows and what that
proves: "Signup blocked for a disallowed domain — the 403 page renders."
Never put secrets, tokens, or personal data in the caption — or the pixels.

## Binding with --for

When a criterion is the reason you captured, bind it:

    outerlayer emit artifact shot.png --caption "…" --for AC-084-11

The id comes from the acceptance spec (`acceptance/*.md`). A criterion that
declares a required form (`(proof: video)`) is satisfied only by that kind —
a screenshot bound to a video criterion renders as "video required ·
screenshot attached" and does not count. Match the declared form.

## The noise rule

Satisfy the declared proofs; don't document everything. One exhibit per
criterion is the norm. An unrequested artifact is worth emitting only when
it would change how a reviewer reads the diff. When in doubt, leave it out —
evidence works because there is little of it.

## Mechanics

Inside a recorded session, just run the command — the artifact spools
locally and uploads with the next `outerlayer sync`, bound to this session
and turn. In CI, run it after the step that produced the file (repo and PR
come from the CI environment). From a plain machine it anchors through the
git checkout, or pass `--pr <n>` explicitly. If there is nothing to attach
to, the command refuses — emit from the work, not from nowhere.
