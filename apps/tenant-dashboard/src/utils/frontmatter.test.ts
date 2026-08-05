import { parseFrontMatter } from "./frontmatter";

describe("parseFrontMatter", () => {
  it("parses frontmatter with colon in value", () => {
    const content = `---
abc: 1:1
---
body content`;

    const result = parseFrontMatter(content);
    expect(result.attributes).toEqual({ abc: "1:1" });
    expect(result.body).toBe("body content");
  });

  it("parses nested config", () => {
    const content = `---
name: test
text_config:
  model_name: gpt-4
---
# Hello World`;

    const result = parseFrontMatter<{ name: string; text_config: { model_name: string } }>(content);
    expect(result.attributes.name).toBe("test");
    expect(result.attributes.text_config.model_name).toBe("gpt-4");
    expect(result.body).toBe("# Hello World");
  });

  it("returns empty attributes when no frontmatter", () => {
    const content = "Just regular content";
    const result = parseFrontMatter(content);
    expect(result.attributes).toEqual({});
    expect(result.body).toBe("Just regular content");
  });

  it("handles empty frontmatter", () => {
    const content = `---

---
body`;

    const result = parseFrontMatter(content);
    expect(result.attributes).toEqual({});
    expect(result.body).toBe("body");
  });

  it("throws on invalid YAML", () => {
    const content = `---
invalid: yaml: syntax: here
  bad indentation
---
body`;

    expect(() => parseFrontMatter(content)).toThrow("Failed to parse frontmatter");
  });
});
