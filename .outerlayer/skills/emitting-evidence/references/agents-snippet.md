<!-- outerlayer:capture-pack -->
## Emitting evidence

When you finish work a spec criterion covers — especially one declaring a
required proof form ("proof: video") — capture the working state and emit it:

    outerlayer emit artifact <file> --caption "what it shows" [--for <criterion-id>] [--pr <n>]

Rules: capture AFTER the state exists (run it, then shoot it); kind comes
from the file type (png/jpg screenshot, webm/mp4 video, html/pdf report,
txt/log log — anything else is a plain file and satisfies nothing
stronger); every artifact caps at 8 MiB, and video is the kind most likely
to hit it; captions are one present-tense sentence with no secrets; bind
`--for` the criterion id from the acceptance spec, matching its declared
form exactly; satisfy declared proofs and stop — don't document everything.
Inside a recorded session the artifact uploads on the next `outerlayer
sync`; in CI it anchors via the CI environment; otherwise the git checkout
or `--pr` anchors it, and with nothing to attach to the command refuses.
