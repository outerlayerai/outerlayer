// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The eval worker's control-plane client (least-privilege worker). The
 * worker's ONLY credential is its per-run gateway key — it never holds a
 * database credential. Everything it needs from the control plane goes
 * through three endpoints, all bound server-side to this one run:
 *
 *   GET  /v1/evals/runs/{runId}/job     — the job spec
 *   POST /v1/evals/runs/{runId}/status  — running | succeeded | failed
 *                                         (terminal statuses revoke the key)
 *   POST /v1/evals/escalations          — the env-escalation sink
 *
 * Failure semantics: `fetchJob` and `claim` throw after retries (a worker
 * that can't load or claim its job must exit loudly); `complete`/`fail`
 * throw too — the caller exits non-zero and the stuck-run backstop is the
 * key's 24h expiry plus the run reaper. The escalation writer throws on
 * non-2xx so `persistingEscalationSink` logs it without failing the run.
 */

import type { EnvEscalationRow } from "./escalation-bridge.js";

export interface EvalRunJob {
  id: string;
  appId: string;
  environmentId: string | null;
  repoLabel: string;
  status: string;
  /** The wizard's run request: { configs: [A, B], taskCount, trialsPerTask, budgetUsd }. */
  request: Record<string, unknown>;
}

export interface EvalGatewayClientOptions {
  gatewayUrl: string;
  /** The per-run key (score.write + trace.write, bound to this run). */
  apiKey: string;
  appId: string;
  runId: string;
  fetchImpl?: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
  /** Attempts per request (>=1). Retries cover network errors, 429 and 5xx. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

export class EvalGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EvalGatewayError";
  }
}

export class EvalGatewayClient {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: Record<string, unknown>) => void;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly base: string;

  constructor(private readonly opts: EvalGatewayClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.base = opts.gatewayUrl.replace(/\/+$/, "");
  }

  async fetchJob(): Promise<EvalRunJob> {
    const payload = await this.request("GET", `/v1/evals/runs/${this.opts.runId}/job`);
    return (payload as { data: EvalRunJob }).data;
  }

  /** Claim the run. Idempotent — a Fly restart re-claims without error. */
  async claim(): Promise<void> {
    await this.request("POST", `/v1/evals/runs/${this.opts.runId}/status`, { status: "running" });
  }

  /** Terminal success. Also revokes this client's key server-side — call it
   * LAST (after trial/session persistence, which still needs the key). */
  async complete(card: unknown, costUsd: number): Promise<void> {
    await this.request("POST", `/v1/evals/runs/${this.opts.runId}/status`, {
      status: "succeeded",
      card,
      costUsd,
    });
  }

  /** Terminal failure. Also revokes this client's key server-side. */
  async fail(error: string): Promise<void> {
    await this.request("POST", `/v1/evals/runs/${this.opts.runId}/status`, {
      status: "failed",
      error: error.slice(0, 2000),
    });
  }

  /** Row writer for `persistingEscalationSink`: maps the OSS row onto the
   * wire schema (tenant/app/run identity is stamped server-side from the
   * key binding — never sent). */
  escalationWriter(): (row: EnvEscalationRow) => Promise<void> {
    return async (row) => {
      await this.request("POST", "/v1/evals/escalations", {
        repo: row.repo,
        base_commit: row.base_commit,
        task_ids: row.task_ids,
        last_errors: row.last_errors,
        attempts: row.attempts,
        cost_usd: row.cost_usd,
        suggested_next_steps: row.suggested_next_steps,
      });
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let lastDetail = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.base}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.apiKey}`,
            "x-outerlayer-app-id": this.opts.appId,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (res.ok) {
          return await res.json().catch(() => ({}));
        }
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        if (res.status === 429 || res.status >= 500) {
          lastDetail = `${res.status}: ${detail}`;
        } else {
          // Permanent (auth/binding/contract) — retrying cannot help.
          throw new EvalGatewayError(`${method} ${path} -> ${res.status}: ${detail}`, res.status);
        }
      } catch (err) {
        if (err instanceof EvalGatewayError) throw err;
        lastDetail = String(err instanceof Error ? err.message : err).slice(0, 300);
      }
      if (attempt < this.maxAttempts) await sleep(this.retryDelayMs * attempt);
    }
    this.log({
      _alert: true,
      evt: "eval.gateway.unreachable",
      runId: this.opts.runId,
      path,
      detail: lastDetail,
    });
    throw new EvalGatewayError(`${method} ${path} failed after ${this.maxAttempts} attempts: ${lastDetail}`, 0);
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
