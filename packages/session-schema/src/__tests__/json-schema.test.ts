// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentSessionJsonSchema, AGENT_SESSION_SCHEMA_ID } from "../json-schema.js";
import { canonicalStringify } from "../canonical.js";
import { FIELD_TIERS } from "../tiers.js";

const SCHEMA_FILE = join(__dirname, "..", "..", "fixtures", "agent-session.v1.schema.json");

/** Resolve a FIELD_TIERS path ("turns[].toolCalls[].input") inside the
 * exported JSON Schema; returns the sub-schema or undefined. */
function resolvePath(schema: Record<string, unknown>, path: string): Record<string, unknown> | undefined {
  const segs = path
    .split(".")
    .flatMap((s) => (s.endsWith("[]") ? [s.slice(0, -2), "[]"] : [s]));
  let node: Record<string, unknown> | undefined = schema;
  for (const seg of segs) {
    if (!node) return undefined;
    if (seg === "[]") {
      node = node.items as Record<string, unknown> | undefined;
    } else {
      const props = node.properties as Record<string, Record<string, unknown>> | undefined;
      node = props?.[seg];
    }
  }
  return node;
}

describe("published JSON Schema", () => {
  it("matches the committed golden byte-for-byte", () => {
    expect(canonicalStringify(agentSessionJsonSchema(), 2) + "\n").toBe(
      readFileSync(SCHEMA_FILE, "utf8"),
    );
  });

  it("carries the versioned $id", () => {
    const schema = agentSessionJsonSchema();
    expect(schema.$id).toBe(AGENT_SESSION_SCHEMA_ID);
    expect(schema.$id).toBe("https://outerlayer.ai/schemas/agent-session.v1.json");
  });

  it("is loose (additive-only v1): unknown properties allowed at the root", () => {
    const schema = agentSessionJsonSchema();
    // zod renders looseObject catchall as additionalProperties: {} (accept-any)
    expect(schema.additionalProperties).toEqual({});
  });

  it("every FIELD_TIERS path is annotated tier:<min> in the published schema", () => {
    const schema = agentSessionJsonSchema();
    for (const [path, tier] of Object.entries(FIELD_TIERS)) {
      const node = resolvePath(schema, path);
      expect(node, `path ${path} must resolve in the JSON Schema`).toBeDefined();
      expect(node?.description, `path ${path}`).toBe(`tier:${tier}`);
    }
  });

  it("no stray tier annotations beyond FIELD_TIERS (scan the whole document)", () => {
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node === "object" && node !== null) {
        const rec = node as Record<string, unknown>;
        if (typeof rec.description === "string" && rec.description.startsWith("tier:")) {
          found.push(rec.description);
        }
        Object.values(rec).forEach(walk);
      }
    };
    walk(agentSessionJsonSchema());
    expect(found.length).toBe(Object.keys(FIELD_TIERS).length);
  });
});
