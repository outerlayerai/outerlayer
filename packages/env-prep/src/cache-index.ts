// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The snapshot cache INDEX — metadata beside the provider's
 * images: build/probe times, last use, sizes when known. Providers own the
 * bytes; this file owns the bookkeeping and the LRU eviction decision.
 *
 * Eviction is by bytes when sizes are known (LocalDocker can report them;
 * inject via `sizeOf`), oldest-last-used first; entries without sizes are
 * treated as size 0 for the budget but still age out by recency. Pinned
 * keys (canary repos) are never evicted.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface CacheIndexEntry {
  key: string;
  imageRef: string;
  repo: string;
  baseCommit: string;
  source: "deterministic" | "repaired";
  builtAtIso: string;
  lastUsedAtIso: string;
  buildMs: number;
  probeMs: number;
  sizeBytes?: number;
  pinned?: boolean;
}

interface IndexFile {
  schemaVersion: 1;
  entries: CacheIndexEntry[];
}

export class EnvCacheIndex {
  private entries = new Map<string, CacheIndexEntry>();

  constructor(private readonly path?: string) {}

  static async load(path: string): Promise<EnvCacheIndex> {
    const index = new EnvCacheIndex(path);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as IndexFile;
      for (const entry of parsed.entries) index.entries.set(entry.key, entry);
    } catch {
      // Missing or corrupt index is not fatal — it rebuilds as envs build.
    }
    return index;
  }

  record(entry: CacheIndexEntry): void {
    this.entries.set(entry.key, entry);
  }

  touch(key: string, nowIso = new Date().toISOString()): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsedAtIso = nowIso;
  }

  pin(key: string, pinned = true): void {
    const entry = this.entries.get(key);
    if (entry) entry.pinned = pinned;
  }

  get(key: string): CacheIndexEntry | undefined {
    return this.entries.get(key);
  }

  all(): CacheIndexEntry[] {
    return [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Evict least-recently-used unpinned entries until total tracked bytes
   * fit `maxBytes`. `remove` deletes the provider-side image (e.g.
   * LocalDockerProvider.removeEnvImage); an entry leaves the index only if
   * its removal succeeded. Returns evicted keys in eviction order. */
  async evictLru(maxBytes: number, remove: (key: string) => Promise<void>): Promise<string[]> {
    const evicted: string[] = [];
    const byRecency = [...this.entries.values()].sort((a, b) =>
      a.lastUsedAtIso.localeCompare(b.lastUsedAtIso),
    );
    let total = byRecency.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
    for (const entry of byRecency) {
      if (total <= maxBytes) break;
      if (entry.pinned) continue;
      await remove(entry.key);
      this.entries.delete(entry.key);
      total -= entry.sizeBytes ?? 0;
      evicted.push(entry.key);
    }
    return evicted;
  }

  async save(): Promise<void> {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const file: IndexFile = { schemaVersion: 1, entries: this.all() };
    await writeFile(this.path, JSON.stringify(file, null, 2));
  }
}
