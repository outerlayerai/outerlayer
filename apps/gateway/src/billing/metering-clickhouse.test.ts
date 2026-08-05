import { describe, expect, test, vi } from "vitest";
import { createClient } from "@clickhouse/client-web";
import {
  METERING_QUERY_SETTINGS,
  createMeteringClickHouseClient,
} from "./metering-clickhouse";

vi.mock("@clickhouse/client-web", () => ({
  createClient: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
}));

describe("createMeteringClickHouseClient", () => {
  test("every metering client carries the memory caps, spill thresholds, and per-partition FINAL", () => {
    createMeteringClickHouseClient({
      CLICKHOUSE_HOST: "https://ch.example.com",
      CLICKHOUSE_PASSWORD: "pw",
    });

    expect(vi.mocked(createClient)).toHaveBeenCalledWith({
      url: "https://ch.example.com",
      password: "pw",
      clickhouse_settings: METERING_QUERY_SETTINGS,
    });
    // Pin the actual values: a cap that quietly grows past a small
    // instance's server ceiling re-creates the collateral-kill failure mode.
    expect(METERING_QUERY_SETTINGS).toEqual({
      max_memory_usage: "3000000000",
      max_bytes_before_external_group_by: "700000000",
      max_bytes_before_external_sort: "700000000",
      do_not_merge_across_partitions_select_final: 1,
    });
    // Spill thresholds must sit below the hard cap or they can never engage.
    expect(
      Number(METERING_QUERY_SETTINGS.max_bytes_before_external_group_by),
    ).toBeLessThan(Number(METERING_QUERY_SETTINGS.max_memory_usage));
  });
});
