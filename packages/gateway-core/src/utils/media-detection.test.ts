import { describe, it, expect } from "vitest";
import { containsMedia, hasMediaLeaf } from "./media-detection";

describe("containsMedia", () => {
  it("detects an image array (mimeType + base64)", () => {
    expect(containsMedia('[{"mimeType":"image/png","base64":"iVBORw0KGgo="}]')).toBe(true);
  });

  it("detects a single speech object", () => {
    expect(containsMedia('{"mimeType":"audio/mpeg","base64":"SUQzAAA="}')).toBe(true);
  });

  it("recognizes the Vercel AI SDK 'mediaType' key", () => {
    expect(containsMedia('[{"mediaType":"image/jpeg","base64":"AAA"}]')).toBe(true);
  });

  it("finds media nested inside an object", () => {
    expect(containsMedia('{"result":{"images":[{"mimeType":"image/webp","base64":"X"}]}}')).toBe(true);
  });

  it("is false for plain text", () => {
    expect(containsMedia("the model returned a normal answer")).toBe(false);
  });

  it("is false for prose that merely mentions base64 and mimeType (no media leaf)", () => {
    expect(containsMedia("Here is how base64 and mimeType encoding works in general.")).toBe(false);
  });

  it("is false when base64 is present but there is no mime key (guard short-circuits)", () => {
    expect(containsMedia('{"base64":"AAA"}')).toBe(false);
  });

  it("is false when a mime key is present but no base64", () => {
    expect(containsMedia('{"mimeType":"image/png","url":"https://x/y.png"}')).toBe(false);
  });

  it("is false for invalid JSON even when the substrings are present", () => {
    expect(containsMedia("base64 mimeType {not valid json")).toBe(false);
  });
});

describe("hasMediaLeaf", () => {
  it("requires BOTH a mime key and a base64 string on the same object", () => {
    expect(hasMediaLeaf({ mimeType: "image/png", base64: "AAA" })).toBe(true);
    expect(hasMediaLeaf({ mimeType: "image/png" })).toBe(false);
    expect(hasMediaLeaf({ base64: "AAA" })).toBe(false);
    expect(hasMediaLeaf({ mimeType: 123, base64: "AAA" })).toBe(false);
  });

  it("returns false for primitives and null", () => {
    expect(hasMediaLeaf(null)).toBe(false);
    expect(hasMediaLeaf("str")).toBe(false);
    expect(hasMediaLeaf(42)).toBe(false);
  });
});
