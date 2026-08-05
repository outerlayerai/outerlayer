import { scrubEmail } from "../scrub-email";

describe("scrubEmail", () => {
  it("should mask email local part preserving first 3 chars", () => {
    expect(scrubEmail("john.doe@example.com")).toBe("joh***@example.com");
    expect(scrubEmail("alice@company.io")).toBe("ali***@company.io");
    expect(scrubEmail("testing123@domain.org")).toBe("tes***@domain.org");
  });

  it("should handle short local parts", () => {
    expect(scrubEmail("ab@test.io")).toBe("ab***@test.io");
    expect(scrubEmail("a@test.io")).toBe("a***@test.io");
  });

  it("should preserve full domain", () => {
    expect(scrubEmail("user@subdomain.example.com")).toBe("use***@subdomain.example.com");
  });

  it("should return [invalid] for empty or null input", () => {
    expect(scrubEmail("")).toBe("[invalid]");
    expect(scrubEmail(null as unknown as string)).toBe("[invalid]");
    expect(scrubEmail(undefined as unknown as string)).toBe("[invalid]");
  });

  it("should return [invalid] for non-string input", () => {
    expect(scrubEmail(123 as unknown as string)).toBe("[invalid]");
    expect(scrubEmail({} as unknown as string)).toBe("[invalid]");
  });

  it("should return [invalid] for malformed emails", () => {
    expect(scrubEmail("notanemail")).toBe("[invalid]");
    expect(scrubEmail("@nodomain.com")).toBe("[invalid]");
    expect(scrubEmail("noat")).toBe("[invalid]");
    expect(scrubEmail("multiple@at@signs.com")).toBe("[invalid]");
  });
});
