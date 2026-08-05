/**
 * `listAuditLogInputSchema` — validated both by `listAuditLogAction` (real
 * numbers from the table's client call) and directly by the settings page
 * React Server Component (RSC) (raw `searchParams` strings). A malformed `?page=` must fail rather
 * than coerce to NaN/a negative offset and corrupt the pagination math.
 */
import { listAuditLogInputSchema } from "./schemas";

describe("listAuditLogInputSchema", () => {
  it("coerces numeric-string page/pageSize (the searchParams shape)", () => {
    const result = listAuditLogInputSchema.safeParse({ page: "2", pageSize: "10" });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ page: 2, pageSize: 10 });
  });

  it("accepts real numbers unchanged (the client action-call shape)", () => {
    const result = listAuditLogInputSchema.safeParse({ page: 3, pageSize: 50 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ page: 3, pageSize: 50 });
  });

  it.each([
    ["abc", "a non-numeric page"],
    ["-1", "a negative page"],
    ["0", "a zero page"],
    ["1.5", "a non-integer page"],
  ])("rejects %j (%s) rather than coercing to a broken offset", (page) => {
    const result = listAuditLogInputSchema.safeParse({ page });

    expect(result.success).toBe(false);
  });

  it("rejects a pageSize above the 100-row cap", () => {
    const result = listAuditLogInputSchema.safeParse({ pageSize: "500" });

    expect(result.success).toBe(false);
  });

  it("omits page/pageSize/actionType/targetType entirely when absent", () => {
    const result = listAuditLogInputSchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({});
  });
});
