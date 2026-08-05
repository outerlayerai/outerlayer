// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Escalation: the repair ladder never fails silently — exhausted
 * budgets produce a human-readable item. In cloud mode the sink writes a
 * table + notification; in CLI mode it prints. This queue doubles as
 * design-partner concierge intake, so the item must read like a ticket, not
 * a stack trace.
 */

export interface EscalationItem {
  repo: string;
  baseCommit: string;
  taskIds: string[];
  /** Most recent first, bounded. */
  lastErrors: { stage: string; excerpt: string; setup: string }[];
  attempts: number;
  costUsd: number;
  suggestedNextSteps: string;
  createdAt: string;
}

export interface EscalationSink {
  report(item: EscalationItem): Promise<void>;
}

/** CLI-mode sink: actionable text on stderr. */
export function consoleEscalationSink(
  write: (line: string) => void = (line) => console.error(line),
): EscalationSink {
  return {
    async report(item) {
      write(`⛑ env escalation — ${item.repo}@${item.baseCommit} (${item.taskIds.length} task(s))`);
      write(`  attempts: ${item.attempts} · spent: $${item.costUsd.toFixed(2)}`);
      for (const error of item.lastErrors) {
        write(`  [${error.stage}] ${error.excerpt}`);
      }
      write(`  next: ${item.suggestedNextSteps}`);
    },
  };
}

/** Test/cloud-buffer sink. */
export function collectEscalationSink(items: EscalationItem[]): EscalationSink {
  return {
    async report(item) {
      items.push(item);
    },
  };
}
