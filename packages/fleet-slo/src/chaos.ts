// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The chaos suite. Each scenario injects a specific fault and
 * asserts the runner handles it with a TYPED outcome and no silent loss — the
 * crash-recovery contract. This wraps any SandboxProvider with a fault
 * schedule, so the same scenarios run against LocalDocker/managed.
 *
 * The scenarios here are the deterministic, fixture-driven ones; the fleet also runs
 * one live-infra pass per release. The point proven in tests: a killed
 * sandbox / a vendor 500 / a corrupt env surfaces as infra_error (retryable)
 * or the correct typed status — never a hang, never an untyped failure.
 */

import type {
  EnvRef, EnvSpec, ExecOpts, ExecResult, FileMap, Sandbox, SandboxInfo, SandboxOpts, SandboxProvider,
} from "@outerlayer/runner-core";

export type ChaosFault =
  | { kind: "create_throws"; onNetwork?: "default" | "none" }
  | { kind: "exec_throws"; match: string }
  | { kind: "exec_hang_timeout"; match: string }
  | { kind: "env_corrupt" }; // prepareEnv returns a broken ref that fails at create

export interface ChaosSchedule {
  /** Faults fire on the Nth matching operation (1-based), then stop. */
  faults: ChaosFault[];
}

/** Wraps a provider; injects the scheduled faults exactly once each. */
export class FaultInjectingProvider implements SandboxProvider {
  readonly id: string;
  private fired = new Set<number>();

  constructor(
    private readonly inner: SandboxProvider,
    private readonly schedule: ChaosSchedule,
  ) {
    this.id = `chaos:${inner.id}`;
  }

  async prepareEnv(spec: EnvSpec): Promise<EnvRef> {
    const corrupt = this.take("env_corrupt");
    const env = await this.inner.prepareEnv(spec);
    return corrupt ? { ...env, imageRef: "corrupt://missing" } : env;
  }

  async create(env: EnvRef, opts?: SandboxOpts): Promise<Sandbox> {
    const fault = this.schedule.faults.find(
      (f, i) => f.kind === "create_throws" && !this.fired.has(i) && (!("onNetwork" in f) || !f.onNetwork || f.onNetwork === (opts?.network ?? "default")),
    );
    if (fault) {
      this.fired.add(this.schedule.faults.indexOf(fault));
      throw new Error("chaos: sandbox create failed (daemon killed)");
    }
    if (env.imageRef === "corrupt://missing") {
      throw new Error("chaos: env image is corrupt / missing");
    }
    return this.inner.create(env, opts);
  }

  async exec(sandbox: Sandbox, cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    for (let i = 0; i < this.schedule.faults.length; i++) {
      const fault = this.schedule.faults[i]!;
      if (this.fired.has(i)) continue;
      if (fault.kind === "exec_throws" && cmd.includes(fault.match)) {
        this.fired.add(i);
        throw new Error(`chaos: exec transport error on "${fault.match}"`);
      }
      if (fault.kind === "exec_hang_timeout" && cmd.includes(fault.match)) {
        this.fired.add(i);
        return { code: 124, stdout: "", stderr: "", ms: opts?.timeoutMs ?? 0, truncated: false, timedOut: true };
      }
    }
    return this.inner.exec(sandbox, cmd, opts);
  }

  putFiles(sandbox: Sandbox, files: FileMap): Promise<void> {
    return this.inner.putFiles(sandbox, files);
  }
  getFile(sandbox: Sandbox, path: string): Promise<Buffer> {
    return this.inner.getFile(sandbox, path);
  }
  destroy(sandbox: Sandbox): Promise<void> {
    return this.inner.destroy(sandbox);
  }
  list(): Promise<SandboxInfo[]> {
    return this.inner.list();
  }

  private take(kind: ChaosFault["kind"]): boolean {
    const i = this.schedule.faults.findIndex((f, idx) => f.kind === kind && !this.fired.has(idx));
    if (i < 0) return false;
    this.fired.add(i);
    return true;
  }
}

export interface ChaosScenario {
  name: string;
  schedule: ChaosSchedule;
  /** The typed status(es) the runner must produce — never a hang/untyped. */
  expectStatusIn: string[];
}

/** The canonical fixture scenarios (spec: kill mid-agent, kill mid-grade,
 * corrupt env cache, inject vendor 500s). Each asserts typed handling. */
export const CHAOS_SCENARIOS: ChaosScenario[] = [
  { name: "kill sandbox mid-agent (create fails)", schedule: { faults: [{ kind: "create_throws", onNetwork: "default" }] }, expectStatusIn: ["infra_error", "graded"] },
  { name: "kill sandbox mid-grade (grade create fails)", schedule: { faults: [{ kind: "create_throws", onNetwork: "none" }] }, expectStatusIn: ["infra_error"] },
  { name: "corrupt env cache entry", schedule: { faults: [{ kind: "env_corrupt" }] }, expectStatusIn: ["infra_error"] },
  { name: "vendor 500 on the agent run", schedule: { faults: [{ kind: "exec_throws", match: "git diff --cached" }] }, expectStatusIn: ["infra_error"] },
  // Match "-m pytest" (the grade test invocation), NOT bare "pytest": the
  // freeze-patch command greps ARTIFACT_DENYLIST_RE, which contains
  // ".pytest_cache", so a bare "pytest" match would fire the hang on patch
  // capture (→ empty patch → agent_error) instead of at grade time.
  { name: "hung test at grade time", schedule: { faults: [{ kind: "exec_hang_timeout", match: "-m pytest" }] }, expectStatusIn: ["graded"] },
];
