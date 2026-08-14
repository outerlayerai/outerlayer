// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Emitted-result contract shared by the CLI (`outerlayer emit <name>`) and
 * the gateway (ingest). An emitted result is the record of a check that ran
 * in the customer's infrastructure — their CI, their compute — and reported
 * its outcome; the evidence engine evaluates these records against the
 * validators that declare the name, and never executes anything itself.
 *
 * Invariants both ends must agree on:
 *
 *   - the name is a DECLARATION reference: a result only ever surfaces
 *     through a validator whose definition declares the emit name, so the
 *     shape stays id-characters-only — a stored name can never carry
 *     markdown, spaces, or HTML into a rendered surface;
 *   - provenance (`ci` / `local`) is NEVER part of the wire payload. The
 *     server derives it from how the result arrived; a caller cannot claim
 *     it.
 */
import { z } from "zod";

export const EMITTED_RESULT_PROVENANCES = ["ci", "local"] as const;
export type EmittedResultProvenance = (typeof EMITTED_RESULT_PROVENANCES)[number];

export const EMITTED_RESULTS = ["pass", "fail"] as const;
export type EmittedResultOutcome = (typeof EMITTED_RESULTS)[number];

/** Emit names as validator files declare them (`run: {where: ci, emit: …}`):
 * lowercase slug with dots (`smoke.pass`, `migration.executed`). */
export const EmittedNameSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);

/** The run URL the emitting CI step supplies — the row's proof link. Length
 * bounded here so neither end stores an unbounded attacker-sized string. */
export const EMITTED_RESULT_MAX_LINK_LENGTH = 500;

/** Request body of `POST /v1/emitted-results`. `ci` marks CI-environment
 * context and is advisory — the server downgrades it unless the API key
 * shape agrees. `prNumber` is required: an emitted result carries its PR
 * anchor at ingest or is refused (there is no reconciliation tier). */
export interface EmitResultRequest {
  schemaVersion: 1;
  emit: {
    clientEmitId: string;
    name: string;
    result: EmittedResultOutcome;
    link: string;
    emittedAt: string;
    ci?: boolean;
    prNumber: number;
    repository?: string;
    gitRepo?: string;
  };
}
