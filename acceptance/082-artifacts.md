# Artifacts — Acceptance Criteria

An artifact is an exhibit — a screenshot, recording, report, or log emitted as
proof that a change works — anchored to a pull request and rendered in the PR
comment's Evidence section. Artifacts are not a fourth primitive: they are a
proof type for acceptance criteria. Evidence is always evidence *of*
something, so every artifact resolves to a PR — directly, or through the
session that produced it — and provenance (`session` / `ci` / `local`) is
derived from how the artifact was submitted, never claimed by the caller.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Emit and anchoring

1. `AC-082-01` **Given** a workspace API key and a file on disk, **When** `outerlayer emit artifact <file> --caption "…"` runs with an anchor available (an active session, CI PR context, or `--pr`), **Then** the accepted record carries the caption, the kind inferred from the file's media type, the optional `--for` criterion id, and a provenance value the server derived from the submission path.
2. `AC-082-02` **Given** an emit invocation running inside a recorded session, **When** the artifact is emitted, **Then** the CLI spools it locally (blob plus record with timestamp, cwd, and git context) and nothing uploads until `outerlayer sync`, which merges the record into the session by matching the recorded emit call, binding the artifact to that session and turn with `session` provenance.
3. `AC-082-03` **Given** an emit invocation in CI where the environment supplies repo and PR context and the API key supplies the workspace, **When** the artifact is emitted, **Then** upload is immediate, the artifact binds straight to the PR, and provenance is `ci`.
4. `AC-082-04` **Given** an emit invocation from a machine that is neither a recorded session nor CI, **When** the artifact is emitted from a git checkout, **Then** provenance is `local` and the artifact anchors via the checkout's git context (branch and commit within the PR's activity window) or an explicit `--pr` number.
5. `AC-082-05` **Given** a caller that tries to claim a stronger provenance than its submission path (for example a plain upload claiming `session` or `ci`), **When** the gateway accepts the artifact, **Then** the stored provenance is the one derived from the submission path and the claimed value is ignored.
6. `AC-082-06` **Given** an emit invocation with no anchor — no active session, no CI PR context, no `--pr`, and no git repository context — **When** the command runs, **Then** it is refused with "nothing to attach this to" and no record or blob is stored.
7. `AC-082-07` **Given** an accepted artifact whose PR is not yet known, **When** the reconciler later links its session or git context to a pull request within the grace window, **Then** the artifact moves `pending → confirmed` and carries that PR as its anchor.
8. `AC-082-08` **Given** a pending artifact whose grace window has elapsed with no PR match, **When** the age-out sweep runs, **Then** the artifact is marked `unmatched` and its blob bytes are deleted.

## Kind inference

1. `AC-082-09` **Given** an emitted file, **When** its media type is recognized, **Then** kind is inferred as webm/mp4 → `video`, png/jpeg → `screenshot`, html/pdf → `report`, and plain-text/log → `log`.
2. `AC-082-10` **Given** an emitted file with an unrecognized media type, **When** the artifact is stored and rendered, **Then** its kind is `file` — never guessed into a stronger kind.

## Evidence rendering

1. `AC-082-11` (proof: screenshot) **Given** a PR with accepted artifacts, **When** the comment renders, **Then** the Evidence section contains an Artifacts subgroup listing each artifact as a link with its kind, name, and caption, artifacts whose provenance is not `session` carry a provenance label, and the Evidence summary line carries the artifact count.
2. `AC-082-12` **Given** a PR with no artifacts, **When** the comment renders, **Then** no Artifacts subgroup and no artifact count appear.
3. `AC-082-13` **Given** artifacts of image kinds, **When** the comment renders without an explicit org opt-in for inline media, **Then** artifacts render as links only — no inline image markup.
4. `AC-082-14` **Given** a criterion that requires proof kind `video` and an artifact of kind `video` emitted `--for` that criterion, **When** the comment renders, **Then** the artifact renders as that criterion's proof link.
5. `AC-082-15` **Given** a criterion that requires proof kind `video`, **When** the comment renders, **Then** a criterion with only a `screenshot` bound renders "video required · screenshot attached", one with nothing bound renders "video required · none attached", and in neither case does the criterion read as satisfied.
6. `AC-082-16` **Given** artifact captions containing markdown, pipes, or inline HTML, **When** the comment renders, **Then** the caption text is escaped so it cannot break the row or link structure or inject markup, and artifact rows carry no human names and no transcript content.
7. `AC-082-17` **Given** the same artifact records rendered twice, **When** nothing changed, **Then** the Artifacts subgroup is byte-identical across runs — artifacts bound to criteria first, then by emit time.

## Capture pack

1. `AC-082-18` **Given** a repository, **When** `outerlayer import capture` installs the capture pack, **Then** it writes the Claude Code skill and the AGENTS.md snippet covering when to capture, per-kind mechanics, caption conventions, binding with `--for`, and the noise rule.
