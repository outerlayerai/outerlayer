import { describe, it, expect } from "vitest";
import { resolveFileType, isDatasetFile } from "../file-type-resolver";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("resolveFileType", () => {
  // ── Prompt files (.prompt.mdx) ──────────────────────────────────────────

  it("should resolve .prompt.mdx as prompt type", () => {
    const result = resolveFileType("greeting.prompt.mdx");

    expect(result).toEqual({
      name: "greeting",
      extension: ".prompt.mdx",
      type: "prompt",
    });
  });

  it("should resolve multi-word .prompt.mdx file name", () => {
    const result = resolveFileType("my-long-prompt-name.prompt.mdx");

    expect(result).toEqual({
      name: "my-long-prompt-name",
      extension: ".prompt.mdx",
      type: "prompt",
    });
  });

  it("should resolve .prompt.mdx when name contains dots", () => {
    const result = resolveFileType("v2.1.prompt.mdx");

    expect(result).toEqual({
      name: "v2.1",
      extension: ".prompt.mdx",
      type: "prompt",
    });
  });

  it("should resolve .prompt.mdx with empty name prefix", () => {
    const result = resolveFileType(".prompt.mdx");

    expect(result).toEqual({
      name: "",
      extension: ".prompt.mdx",
      type: "prompt",
    });
  });

  // ── Component files (.mdx, .md) ────────────────────────────────────────

  it("should resolve .mdx as component type", () => {
    const result = resolveFileType("header.mdx");

    expect(result).toEqual({
      name: "header",
      extension: ".mdx",
      type: "component",
    });
  });

  it("should resolve .md as component type", () => {
    const result = resolveFileType("helper.md");

    expect(result).toEqual({
      name: "helper",
      extension: ".md",
      type: "component",
    });
  });

  // ── Prompt takes priority over component (.prompt.mdx ends with .mdx) ─

  it("should resolve .prompt.mdx as prompt not component", () => {
    // .prompt.mdx ends with .mdx, but prompt check runs first
    const result = resolveFileType("test.prompt.mdx");

    expect(result.type).toBe("prompt");
    expect(result.extension).toBe(".prompt.mdx");
  });

  // ── Dataset files (.jsonl) ─────────────────────────────────────────────

  it("should resolve .jsonl as dataset type", () => {
    const result = resolveFileType("training-data.jsonl");

    expect(result).toEqual({
      name: "training-data",
      extension: ".jsonl",
      type: "dataset",
    });
  });

  // ── Schema files (.json) ───────────────────────────────────────────────

  it("should resolve .json as schema type", () => {
    const result = resolveFileType("address.json");

    expect(result).toEqual({
      name: "address",
      extension: ".json",
      type: "schema",
    });
  });

  it("should resolve nested-named .json as schema type", () => {
    const result = resolveFileType("user-profile.json");

    expect(result).toEqual({
      name: "user-profile",
      extension: ".json",
      type: "schema",
    });
  });

  // ── Unrecognized extensions ────────────────────────────────────────────

  it("should return empty fields for unrecognized extension .txt", () => {
    const result = resolveFileType("readme.txt");

    expect(result).toEqual({ name: "", extension: "", type: "" });
  });

  it("should return empty fields for unrecognized extension .yaml", () => {
    const result = resolveFileType("config.yaml");

    expect(result).toEqual({ name: "", extension: "", type: "" });
  });

  it("should return empty fields for file with no extension", () => {
    const result = resolveFileType("Makefile");

    expect(result).toEqual({ name: "", extension: "", type: "" });
  });

  it("should return empty fields for empty string", () => {
    const result = resolveFileType("");

    expect(result).toEqual({ name: "", extension: "", type: "" });
  });
});

describe("isDatasetFile", () => {
  it("should return true for .jsonl file", () => {
    expect(isDatasetFile("data.jsonl")).toBe(true);
  });

  it("should return true for .jsonl file with path prefix", () => {
    expect(isDatasetFile("datasets/training/data.jsonl")).toBe(true);
  });

  it("should return false for .json file", () => {
    expect(isDatasetFile("schema.json")).toBe(false);
  });

  it("should return false for .mdx file", () => {
    expect(isDatasetFile("prompt.mdx")).toBe(false);
  });

  it("should return false for .prompt.mdx file", () => {
    expect(isDatasetFile("greeting.prompt.mdx")).toBe(false);
  });

  it("should return false for file with no extension", () => {
    expect(isDatasetFile("datafile")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isDatasetFile("")).toBe(false);
  });
});
