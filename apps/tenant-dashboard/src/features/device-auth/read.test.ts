import { seedDeviceAuthMswState } from "@/test-helpers/msw-handlers";

import { loadPendingDeviceAuthRequest } from "./read";

it("maps a pending row to the page's read shape", async () => {
  seedDeviceAuthMswState([
    {
      id: "r1",
      user_code: "AAAA-BBBB",
      device_code_digest: "d1",
      status: "pending",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    },
  ]);

  expect(await loadPendingDeviceAuthRequest("AAAA-BBBB")).toEqual({ requestId: "r1", userCode: "AAAA-BBBB" });
});

it("returns null for a code with no live pending request", async () => {
  expect(await loadPendingDeviceAuthRequest("ZZZZ-ZZZZ")).toBeNull();
});
