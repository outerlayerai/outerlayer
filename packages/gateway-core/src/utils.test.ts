import { describe, expect, it } from "vitest";
import { validatePath, buildDatasetPath } from "./utils";

describe("validatePath", () => {
  it("should allow simple file paths", () => {
    expect(validatePath("file.txt")).toBe("file.txt");
    expect(validatePath("folder/file.txt")).toBe("folder/file.txt");
  });

  it("should remove leading slashes", () => {
    expect(validatePath("/file.txt")).toBe("file.txt");
    expect(validatePath("///file.txt")).toBe("file.txt");
  });

  it("should normalize backslashes to forward slashes", () => {
    expect(validatePath("folder\\file.txt")).toBe("folder/file.txt");
  });

  it("should reject path traversal with ../", () => {
    expect(() => validatePath("../etc/passwd")).toThrow("Path traversal detected");
    expect(() => validatePath("foo/../../../etc/passwd")).toThrow("Path traversal detected");
  });

  it("should reject path traversal with ..\\", () => {
    expect(() => validatePath("..\\etc\\passwd")).toThrow("Path traversal detected");
    expect(() => validatePath("foo\\..\\..\\..\\etc\\passwd")).toThrow("Path traversal detected");
  });

  it("should reject encoded path traversal sequences", () => {
    // After backslash normalization, these become ../ sequences
    expect(() => validatePath("..%2Fetc%2Fpasswd")).toThrow("Path traversal detected");
  });

  // Regression tests for encoded bypass vulnerabilities
  it("should reject URL-encoded path traversal %2e%2e", () => {
    expect(() => validatePath("%2e%2e/etc/passwd")).toThrow("Path traversal detected");
    expect(() => validatePath("foo/%2e%2e/%2e%2e/etc/passwd")).toThrow("Path traversal detected");
  });

  it("should reject URL-encoded path traversal %2E%2E (uppercase)", () => {
    expect(() => validatePath("%2E%2E/etc/passwd")).toThrow("Path traversal detected");
    expect(() => validatePath("foo/%2E%2E/etc/passwd")).toThrow("Path traversal detected");
  });

  it("should reject double-encoded path traversal %252e%252e", () => {
    expect(() => validatePath("%252e%252e/etc/passwd")).toThrow("Path traversal detected");
    expect(() => validatePath("foo/%252e%252e/%252e%252e/etc/passwd")).toThrow("Path traversal detected");
  });

  it("should reject mixed encoding in path traversal", () => {
    expect(() => validatePath(".%2e/etc/passwd")).toThrow("Path traversal detected");
    expect(() => validatePath("%2e./etc/passwd")).toThrow("Path traversal detected");
  });

  it("should allow paths with dots that are not traversal", () => {
    expect(validatePath("file.name.txt")).toBe("file.name.txt");
    expect(validatePath(".hidden")).toBe(".hidden");
    expect(validatePath("folder/.hidden")).toBe("folder/.hidden");
  });
});

describe("buildDatasetPath", () => {
  describe("v2+ config (promptsRootPath)", () => {
    it("should use agentmark folder for v2+ versions", () => {
      const result = buildDatasetPath("2.0.0", "/src", undefined, "customer-query.jsonl");
      expect(result).toBe("src/agentmark/customer-query.jsonl");
    });

    it("should handle promptsRootPath of '.' as repo root", () => {
      const result = buildDatasetPath("2.0.0", ".", undefined, "customer-query.jsonl");
      expect(result).toBe("agentmark/customer-query.jsonl");
    });

    it("should handle promptsRootPath of '/' as repo root", () => {
      const result = buildDatasetPath("2.0.0", "/", undefined, "customer-query.jsonl");
      expect(result).toBe("agentmark/customer-query.jsonl");
    });

    it("should default to root when promptsRootPath is undefined", () => {
      const result = buildDatasetPath("2.0.0", undefined, undefined, "customer-query.jsonl");
      expect(result).toBe("agentmark/customer-query.jsonl");
    });

    it("should handle nested promptsRootPath", () => {
      const result = buildDatasetPath("2.1.0", "src/prompts", undefined, "data.jsonl");
      expect(result).toBe("src/prompts/agentmark/data.jsonl");
    });
  });

  describe("v1 config (configPath)", () => {
    it("should use templates folder for v1 versions", () => {
      const result = buildDatasetPath("1.0.0", undefined, "/src", "data.jsonl");
      expect(result).toBe("src/templates/data.jsonl");
    });

    it("should handle configPath of '.' as repo root", () => {
      const result = buildDatasetPath("1.0.0", undefined, ".", "data.jsonl");
      expect(result).toBe("templates/data.jsonl");
    });

    it("should handle configPath of '/' as repo root", () => {
      const result = buildDatasetPath("1.0.0", undefined, "/", "data.jsonl");
      expect(result).toBe("templates/data.jsonl");
    });

    it("should default to root when configPath is undefined", () => {
      const result = buildDatasetPath("1.0.0", undefined, undefined, "data.jsonl");
      expect(result).toBe("templates/data.jsonl");
    });
  });

  describe("filePath sanitization", () => {
    it("should strip leading ./ from filePath", () => {
      const result = buildDatasetPath("2.0.0", ".", undefined, "./customer-query.jsonl");
      expect(result).toBe("agentmark/customer-query.jsonl");
    });

    it("should strip leading / from filePath", () => {
      const result = buildDatasetPath("2.0.0", "/", undefined, "/customer-query.jsonl");
      expect(result).toBe("agentmark/customer-query.jsonl");
    });

    it("should strip multiple leading ./ sequences", () => {
      const result = buildDatasetPath("2.0.0", ".", undefined, "././customer-query.jsonl");
      expect(result).toBe("agentmark/customer-query.jsonl");
    });

    it("should preserve nested paths in filePath", () => {
      const result = buildDatasetPath("2.0.0", ".", undefined, "datasets/customer-query.jsonl");
      expect(result).toBe("agentmark/datasets/customer-query.jsonl");
    });
  });

  describe("version edge cases", () => {
    it("should treat empty version as v1", () => {
      const result = buildDatasetPath("", undefined, undefined, "data.jsonl");
      expect(result).toBe("templates/data.jsonl");
    });

    it("should treat versions above 2.0.0 as v2", () => {
      const result = buildDatasetPath("3.0.0", ".", undefined, "data.jsonl");
      expect(result).toBe("agentmark/data.jsonl");
    });

    it("should treat 1.9.9 as v1", () => {
      const result = buildDatasetPath("1.9.9", undefined, "/prompts", "data.jsonl");
      expect(result).toBe("prompts/templates/data.jsonl");
    });
  });
});
