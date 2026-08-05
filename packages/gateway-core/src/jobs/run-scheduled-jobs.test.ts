/**
 * The cron loop structure. Pinned here because both entrypoints (Worker +
 * node self-host) depend on it running the SAME jobs the SAME way:
 *   - every billing metering task runs, in order, each fire-and-forget;
 *   - a task failure routes to logError with its source tag and does NOT
 *     block the other jobs.
 */
import { describe, expect, it, vi } from "vitest";
import { runScheduledJobs, type ScheduledJobDeps } from "./run-scheduled-jobs";
import type { GatewayContext, MeteringTask } from "../runtime/gateway-context";
import type { GatewayScheduleContext } from "../types";

/** A ctx whose waitUntil collects promises (incl. the nested error-log ones)
 *  so the test can drain all fire-and-forget work before asserting. */
function makeHarness(tasks: MeteringTask[]) {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((p: Promise<unknown>) => {
    pending.push(Promise.resolve(p).catch(() => {}));
  });
  const cron = {
    event: { cron: "* * * * *" },
    env: {},
    ctx: { waitUntil },
    cache: {},
  } as unknown as GatewayScheduleContext;
  const meteringTasks = vi.fn(() => tasks);
  const gtx = { billing: { meteringTasks } } as unknown as GatewayContext;
  return { gtx, cron, meteringTasks };
}

async function drain(cron: GatewayScheduleContext) {
  const waitUntil = cron.ctx.waitUntil as unknown as { mock: { calls: [Promise<unknown>][] } };
  // Nested waitUntil (the error-log path) enqueues while we drain, so loop until
  // no new work appears.
  for (let i = 0; i < 10; i++) {
    const batch = waitUntil.mock.calls.map((c) => Promise.resolve(c[0]).catch(() => {}));
    await Promise.allSettled(batch);
    if (waitUntil.mock.calls.length === batch.length) break;
  }
}

const task = (source: string, run: () => Promise<unknown>): MeteringTask => ({ source, run });

describe("runScheduledJobs", () => {
  it("runs every metering task, with no error logging on success", async () => {
    const runA = vi.fn().mockResolvedValue(undefined);
    const runB = vi.fn().mockResolvedValue(undefined);
    const { gtx, cron, meteringTasks } = makeHarness([task("a", runA), task("b", runB)]);
    const logError = vi.fn<ScheduledJobDeps["logError"]>().mockResolvedValue(undefined);

    runScheduledJobs(gtx, cron, { logError });
    await drain(cron);

    expect(meteringTasks).toHaveBeenCalledWith(cron);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("routes a metering task failure to logError with its source, without blocking the others", async () => {
    const boom = new Error("stripe down");
    const runB = vi.fn().mockResolvedValue(undefined);
    const { gtx, cron } = makeHarness([
      task("stripe-meter-handler", vi.fn().mockRejectedValue(boom)),
      task("storage-metering-handler", runB),
    ]);
    const logError = vi.fn<ScheduledJobDeps["logError"]>().mockResolvedValue(undefined);

    runScheduledJobs(gtx, cron, { logError });
    await drain(cron);

    expect(logError).toHaveBeenCalledWith(boom, "stripe-meter-handler");
    expect(runB).toHaveBeenCalledTimes(1); // the sibling still ran
  });

  it("isolates a SYNCHRONOUS throw from a metering task — siblings still run", async () => {
    // A task whose run() throws synchronously (not a rejected promise). Called
    // bare as `task.run().catch()` this escapes the loop and drops every job
    // after it; the fix wraps it so the sync throw lands in the same error path.
    const boom = new Error("sync boom");
    const runB = vi.fn().mockResolvedValue(undefined);
    const { gtx, cron } = makeHarness([
      task("stripe-meter-handler", () => {
        throw boom;
      }),
      task("storage-metering-handler", runB),
    ]);
    const logError = vi.fn<ScheduledJobDeps["logError"]>().mockResolvedValue(undefined);

    runScheduledJobs(gtx, cron, { logError });
    await drain(cron);

    expect(logError).toHaveBeenCalledWith(boom, "stripe-meter-handler");
    expect(runB).toHaveBeenCalledTimes(1); // the sibling after the throw still ran
  });

  it("runs nothing (and logs nothing) when billing contributes no metering tasks (self-host)", async () => {
    const { gtx, cron, meteringTasks } = makeHarness([]);
    const logError = vi.fn<ScheduledJobDeps["logError"]>().mockResolvedValue(undefined);

    runScheduledJobs(gtx, cron, { logError });
    await drain(cron);

    expect(meteringTasks).toHaveBeenCalledWith(cron);
    expect(logError).not.toHaveBeenCalled();
  });
});
