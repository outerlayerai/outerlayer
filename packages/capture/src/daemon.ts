// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { watch, type FSWatcher } from "chokidar";
import {
  copyFileSync,
  mkdirSync,
  renameSync,
  statSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { defaultProjectsDir, defaultRawDir } from "./adapters/claude-code/discover.js";

export interface DaemonOptions {
  root?: string;
  rawRoot?: string;
  /** Debounce window for rapid successive writes (ms). */
  debounceMs?: number;
  /** Periodic full rescan to catch events chokidar missed (ms). */
  rescanMs?: number;
  /** Raw-mirror byte cap; LRU eviction past it. Default 5 GiB. */
  maxRawBytes?: number;
  /** Project-dir globs to include/exclude (matched on the encoded dir name). */
  includeProjects?: RegExp;
  excludeProjects?: RegExp;
  /** Structured log sink (default: silent). */
  onLog?: (event: DaemonLogEvent) => void;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface DaemonLogEvent {
  type: "mirrored" | "evicted" | "rescan" | "error" | "started" | "stopped";
  file?: string;
  bytes?: number;
  detail?: string;
}

/**
 * Copy-out daemon: watches Claude Code transcripts and mirrors
 * raw files to ~/.outerlayer/raw BEFORE Claude Code's 30-day auto-deletion
 * can remove them. Append-only, atomic (temp + rename). Never touches the
 * source files. Zero network.
 */
export class CaptureDaemon {
  private readonly root: string;
  private readonly rawRoot: string;
  private readonly debounceMs: number;
  private readonly rescanMs: number;
  private readonly maxRawBytes: number;
  private readonly includeProjects?: RegExp;
  private readonly excludeProjects?: RegExp;
  private readonly log: (e: DaemonLogEvent) => void;
  private readonly now: () => number;

  private watcher?: FSWatcher;
  private rescanTimer?: ReturnType<typeof setInterval>;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: DaemonOptions = {}) {
    this.root = options.root ?? defaultProjectsDir();
    this.rawRoot = options.rawRoot ?? defaultRawDir();
    this.debounceMs = options.debounceMs ?? 2000;
    this.rescanMs = options.rescanMs ?? 10 * 60 * 1000;
    this.maxRawBytes = options.maxRawBytes ?? 5 * 1024 * 1024 * 1024;
    this.includeProjects = options.includeProjects;
    this.excludeProjects = options.excludeProjects;
    this.log = options.onLog ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** Begin watching. Resolves once the initial scan completes. */
  async start(): Promise<void> {
    mkdirSync(this.rawRoot, { recursive: true });
    this.rescanNow();
    this.watcher = watch(`${this.root}/**/*.jsonl`, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    this.watcher.on("add", (f) => this.schedule(f));
    this.watcher.on("change", (f) => this.schedule(f));
    this.rescanTimer = setInterval(() => this.rescanNow(), this.rescanMs);
    this.log({ type: "started" });
  }

  async stop(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    await this.watcher?.close();
    this.log({ type: "stopped" });
  }

  private schedule(file: string): void {
    if (!this.included(file)) return;
    const existing = this.pending.get(file);
    if (existing) clearTimeout(existing);
    this.pending.set(
      file,
      setTimeout(() => {
        this.pending.delete(file);
        this.mirror(file);
      }, this.debounceMs),
    );
  }

  private included(file: string): boolean {
    const rel = relative(this.root, file);
    const projectDir = rel.split(/[/\\]/)[0] ?? "";
    if (this.includeProjects && !this.includeProjects.test(projectDir)) return false;
    if (this.excludeProjects && this.excludeProjects.test(projectDir)) return false;
    return true;
  }

  /** Copy one transcript to the raw mirror atomically. Public for the tailer
   * loop and tests. Returns bytes written, or null if skipped/unchanged. */
  mirror(file: string): number | null {
    if (!this.included(file)) return null; // honor include/exclude at every entry
    let src;
    try {
      src = statSync(file);
    } catch {
      return null; // source vanished mid-debounce — the race we exist to beat
    }
    const dest = join(this.rawRoot, relative(this.root, file));
    try {
      const prior = statSync(dest);
      // append-only source; skip when the mirror already has ≥ the bytes
      if (prior.size >= src.size && prior.mtimeMs >= src.mtimeMs) return null;
    } catch {
      // no mirror yet — proceed
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp-${this.now()}`;
      copyFileSync(file, tmp);
      renameSync(tmp, dest); // atomic replace
      this.log({ type: "mirrored", file: dest, bytes: src.size });
      this.evictIfNeeded();
      return src.size;
    } catch (err) {
      this.log({ type: "error", file, detail: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** Full sweep of the source tree → mirror anything new/changed. */
  rescanNow(): void {
    const files = this.listJsonl(this.root);
    for (const file of files) {
      if (this.included(file)) this.mirror(file);
    }
    this.log({ type: "rescan", detail: `${files.length} files` });
  }

  private listJsonl(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      let names: string[];
      try {
        names = readdirSync(d);
      } catch {
        return;
      }
      for (const name of names) {
        const p = join(d, name);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(p);
        else if (name.endsWith(".jsonl") && st.size > 0) out.push(p);
      }
    };
    walk(dir);
    return out;
  }

  /** LRU eviction (by mtime) when the mirror exceeds its byte cap. */
  private evictIfNeeded(): void {
    const files = this.listJsonl(this.rawRoot).map((f) => {
      const st = statSync(f);
      return { file: f, bytes: st.size, mtimeMs: st.mtimeMs };
    });
    let total = files.reduce((sum, f) => sum + f.bytes, 0);
    if (total <= this.maxRawBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const f of files) {
      if (total <= this.maxRawBytes) break;
      try {
        unlinkSync(f.file);
        total -= f.bytes;
        this.log({ type: "evicted", file: f.file, bytes: f.bytes });
      } catch {
        // best-effort
      }
    }
  }
}
