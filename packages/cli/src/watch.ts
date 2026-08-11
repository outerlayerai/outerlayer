// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CaptureDaemon, StatuslineAggregator } from "@outerlayer/capture";

export interface WatchOptions {
  once?: boolean;
  home?: string;
}

/** `outerlayer watch` — start the copy-out daemon, writing a pidfile +
 * heartbeat that `doctor` reads, and keeping the statusline state file
 * fresh (the statusline command itself never parses transcripts). */
export async function runWatch(opts: WatchOptions = {}): Promise<void> {
  const home = opts.home ?? homedir();
  const stateDir = join(home, ".outerlayer");
  mkdirSync(stateDir, { recursive: true });

  const statusline = new StatuslineAggregator({ home });

  const daemon = new CaptureDaemon({
    onLog: (e) => {
      if (e.type === "mirrored") {
        process.stdout.write(`mirrored ${e.file}\n`);
        statusline.notifyChange();
      }
      if (e.type === "rescan") statusline.notifyChange();
      if (e.type === "evicted") process.stdout.write(`evicted ${e.file}\n`);
      if (e.type === "error") process.stderr.write(`error ${e.file}: ${e.detail}\n`);
    },
  });

  if (opts.once) {
    daemon.rescanNow();
    statusline.stop(); // flush the rescan's pending debounce into one write
    process.stdout.write("Single sweep complete.\n");
    return;
  }

  writeFileSync(join(stateDir, "daemon.pid"), String(process.pid));
  const heartbeat = join(stateDir, "daemon.heartbeat");
  const beat = () => writeFileSync(heartbeat, new Date().toISOString());
  beat();
  const heartbeatTimer = setInterval(beat, 60_000);

  await daemon.start();
  statusline.refresh();
  process.stdout.write("OuterLayer daemon watching ~/.claude/projects (Ctrl-C to stop)\n");

  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    await daemon.stop();
    statusline.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // keep the process alive
  await new Promise<void>(() => undefined);
}
