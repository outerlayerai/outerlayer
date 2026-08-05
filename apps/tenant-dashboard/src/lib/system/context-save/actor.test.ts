import { resolveActor } from "./actor";

describe("resolveActor", () => {
  it("uses the profile display_name as the commit-trailer name when set", () => {
    expect(
      resolveActor({ email: "ada@example.com", user_metadata: { display_name: "Ada Lovelace" } }),
    ).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("falls back to email when display_name is unset", () => {
    expect(resolveActor({ email: "ada@example.com", user_metadata: {} })).toEqual({
      name: "ada@example.com",
      email: "ada@example.com",
    });
  });

  it("falls back to email when user_metadata is null", () => {
    expect(resolveActor({ email: "ada@example.com", user_metadata: null })).toEqual({
      name: "ada@example.com",
      email: "ada@example.com",
    });
  });

  it("falls back to email when display_name is an empty string", () => {
    expect(
      resolveActor({ email: "ada@example.com", user_metadata: { display_name: "" } }),
    ).toEqual({ name: "ada@example.com", email: "ada@example.com" });
  });

  it("falls back to email when display_name is not a string", () => {
    expect(
      resolveActor({ email: "ada@example.com", user_metadata: { display_name: 42 } }),
    ).toEqual({ name: "ada@example.com", email: "ada@example.com" });
  });

  it("falls back to a fixed placeholder when email is unset", () => {
    expect(resolveActor({ email: null, user_metadata: null })).toEqual({
      name: "unknown@outerlayer.ai",
      email: "unknown@outerlayer.ai",
    });
  });
});
