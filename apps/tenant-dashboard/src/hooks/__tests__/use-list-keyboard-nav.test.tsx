/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook, fireEvent } from "@testing-library/react";
import {
  getAdjacentId,
  useListKeyboardNav,
} from "../use-list-keyboard-nav";

describe("getAdjacentId", () => {
  const ids = ["a", "b", "c"];

  it("returns the next id stepping forward", () => {
    expect(getAdjacentId(ids, "a", 1)).toBe("b");
    expect(getAdjacentId(ids, "b", 1)).toBe("c");
  });

  it("returns the previous id stepping backward", () => {
    expect(getAdjacentId(ids, "c", -1)).toBe("b");
    expect(getAdjacentId(ids, "b", -1)).toBe("a");
  });

  it("returns null at the boundaries (no wrap-around)", () => {
    expect(getAdjacentId(ids, "c", 1)).toBeNull();
    expect(getAdjacentId(ids, "a", -1)).toBeNull();
  });

  it("returns null when the current id is not in the list", () => {
    expect(getAdjacentId(ids, "missing", 1)).toBeNull();
    expect(getAdjacentId(ids, "missing", -1)).toBeNull();
  });

  it("returns null when there is no current selection", () => {
    expect(getAdjacentId(ids, null, 1)).toBeNull();
    expect(getAdjacentId(ids, null, -1)).toBeNull();
  });

  it("returns null for a single-element list (both directions are edges)", () => {
    expect(getAdjacentId(["only"], "only", 1)).toBeNull();
    expect(getAdjacentId(["only"], "only", -1)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(getAdjacentId([], "a", 1)).toBeNull();
  });
});

describe("useListKeyboardNav", () => {
  let onNavigate: Mock<(id: string) => void>;

  beforeEach(() => {
    onNavigate = vi.fn<(id: string) => void>();
  });

  type Props = Parameters<typeof useListKeyboardNav>[0];

  function setup(overrides: Partial<Props> = {}) {
    const initialProps: Props = {
      ids: ["a", "b", "c"],
      currentId: "b",
      enabled: true,
      onNavigate,
      ...overrides,
    };
    return renderHook((props: Props) => useListKeyboardNav(props), {
      initialProps,
    });
  }

  it("navigates to the next id on 'j'", () => {
    setup();
    fireEvent.keyDown(window, { key: "j" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("c");
  });

  it("navigates to the previous id on 'k'", () => {
    setup();
    fireEvent.keyDown(window, { key: "k" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("a");
  });

  it("is case-insensitive ('J' steps forward too)", () => {
    setup();
    fireEvent.keyDown(window, { key: "J" });
    expect(onNavigate).toHaveBeenCalledWith("c");
  });

  it("does nothing at the list boundary", () => {
    setup({ currentId: "c" });
    fireEvent.keyDown(window, { key: "j" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("does nothing while disabled (detail view closed)", () => {
    setup({ enabled: false });
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "k" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("ignores keystrokes typed into a form field", () => {
    setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "j" });
    expect(onNavigate).not.toHaveBeenCalled();
    input.remove();
  });

  it("ignores unrelated keys", () => {
    setup();
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("ignores j/k pressed with a modifier (e.g. cmd+j)", () => {
    setup();
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("reads the latest selection after a rerender (no stale closure)", () => {
    const { rerender } = setup({ currentId: "a" });
    // The list re-renders with a new selected id every time the user steps;
    // the listener must navigate from "c", not the "a" captured on mount.
    rerender({ ids: ["a", "b", "c"], currentId: "c", enabled: true, onNavigate });
    fireEvent.keyDown(window, { key: "k" });
    expect(onNavigate).toHaveBeenCalledWith("b");
  });

  it("unbinds the listener on unmount", () => {
    const { unmount } = setup();
    unmount();
    fireEvent.keyDown(window, { key: "j" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("unbinds the listener when it becomes disabled", () => {
    const { rerender } = setup();
    rerender({ ids: ["a", "b", "c"], currentId: "b", enabled: false, onNavigate });
    fireEvent.keyDown(window, { key: "j" });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
