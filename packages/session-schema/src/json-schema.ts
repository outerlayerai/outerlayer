// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { z } from "zod";
import { AgentSessionSchema, SCHEMA_VERSION } from "./schema.js";

export const AGENT_SESSION_SCHEMA_ID = `https://outerlayer.ai/schemas/agent-session.v${SCHEMA_VERSION}.json`;

/**
 * JSON Schema (draft 2020-12) for AgentSession v1 — the language-agnostic
 * publication of the contract. Tier annotations surface as `description:
 * "tier:<min>"` on gated fields.
 */
export function agentSessionJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AgentSessionSchema, { target: "draft-2020-12" });
  return {
    $id: AGENT_SESSION_SCHEMA_ID,
    title: "AgentSession",
    ...schema,
  };
}
