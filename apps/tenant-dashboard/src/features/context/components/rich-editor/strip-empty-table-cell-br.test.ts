import { describe, expect, it } from "vitest";
import { stripEmptyTableCellBr } from "./strip-empty-table-cell-br";

describe("stripEmptyTableCellBr", () => {
  it("strips the <br /> Milkdown inserts for an empty table cell", () => {
    const markdown = "| a | b |\n| --- | --- |\n| 1 | <br /> |\n";
    expect(stripEmptyTableCellBr(markdown)).toBe("| a | b |\n| --- | --- |\n| 1 | |\n");
  });

  it("strips every empty-cell <br /> in a row, and across multiple rows", () => {
    const markdown = "| a | b | c |\n| --- | --- | --- |\n| <br /> | x | <br /> |\n| <br/> | <br> | z |\n";
    expect(stripEmptyTableCellBr(markdown)).toBe(
      "| a | b | c |\n| --- | --- | --- |\n| | x | |\n| | | z |\n",
    );
  });

  it("leaves a cell with real content alongside a <br /> tag untouched — only a cell that IS just <br /> counts", () => {
    const markdown = "| a |\n| --- |\n| line one<br />line two |\n";
    expect(stripEmptyTableCellBr(markdown)).toBe(markdown);
  });

  it("never touches a literal <br /> a user wrote in ordinary prose (not inside a table row)", () => {
    const markdown = "Some text with a literal <br /> tag in it.\n";
    expect(stripEmptyTableCellBr(markdown)).toBe(markdown);
  });

  it("does not touch a table-row-shaped line inside a fenced code block", () => {
    const markdown = "```md\n| a |\n| --- |\n| <br /> |\n```\n";
    expect(stripEmptyTableCellBr(markdown)).toBe(markdown);
  });

  it("is a no-op on markdown with no tables at all", () => {
    const markdown = "# Title\n\nJust prose, no tables.\n";
    expect(stripEmptyTableCellBr(markdown)).toBe(markdown);
  });
});
