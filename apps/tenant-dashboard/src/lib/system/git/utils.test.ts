import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./utils";

describe("mapWithConcurrency", () => {
  it("returns results in input order even when later items resolve first", async () => {
    const delays = [30, 10, 20, 0];
    const results = await mapWithConcurrency(delays, 4, (delay, i) =>
      new Promise<number>((resolve) => setTimeout(() => resolve(i), delay)),
    );
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never holds more than `limit` calls in flight at once", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item;
    });
    expect(maxInFlight).toBe(3);
  });

  it("runs every item exactly once, unbounded by a limit above the item count", async () => {
    const items = ["a", "b", "c"];
    const calls: string[] = [];
    await mapWithConcurrency(items, 10, async (item) => {
      calls.push(item);
      return item.toUpperCase();
    });
    expect(calls.sort()).toEqual(["a", "b", "c"]);
  });

  it("still runs every item when the limit is 0 or negative, instead of starting zero workers", async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, 0, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30]);

    const negativeResults = await mapWithConcurrency(items, -5, async (n) => n * 10);
    expect(negativeResults).toEqual([10, 20, 30]);
  });

  it("propagates a rejection from any single call", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
