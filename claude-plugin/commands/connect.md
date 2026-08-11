---
description: Connect this machine to an OuterLayer dashboard (device-code login)
---

Connect this machine to OuterLayer so captured sessions sync to a dashboard.

1. Check whether `~/.outerlayer/config.json` already exists and has a `url`
   field. If it does, tell the user this machine already appears connected
   (name the configured `url`) and ask whether they want to reconnect
   (e.g. to a different dashboard) before continuing.
2. If no dashboard URL is already known, ask the user for their OuterLayer
   dashboard URL (e.g. `https://app.outerlayer.ai` for the hosted product,
   or their self-hosted instance's URL).
3. Run the managed CLI's login command, forwarding that URL:

   ```sh
   node ~/.outerlayer/cli/node_modules/outerlayer/dist/index.js login --url <url>
   ```

   If that path does not exist yet (the plugin has not finished its first
   background install), tell the user capture is still installing and to
   retry `/outerlayer:connect` in a minute — do not try to install or run a
   different copy of the CLI yourself.
4. The command prints a one-time code and a verification URL, then waits.
   Show the user the code and URL exactly as printed, and tell them to open
   the URL, sign in, and approve the code. The command finishes on its own
   once they approve it in the dashboard (or reports a clear failure if the
   code is denied or expires).
5. Report the command's own final output back to the user — do not
   paraphrase or invent a success message if the command failed.
