/**
 * CLI Device Login — Start
 *
 * POST /api/cli/device/start
 *
 * Unauthenticated by design: this is the FIRST call a machine with no
 * credentials makes. Creates a pending device_auth_request and hands back
 * the code pair the CLI shows the user and polls with.
 * Contract:
 * - Auth: none
 * - Body: ignored (accepts `{}`)
 * - Response: { device_code, user_code, verification_url, expires_in, interval }
 */

import { NextResponse } from "next/server";
import { createDeviceAuthRequest } from "@/lib/system/device-auth";
import { APP_URL } from "@/config-global";
import { paths } from "@/routes/paths";
import { serverLogger } from "@/lib/observability/server-logger";

export async function POST() {
  try {
    const request = await createDeviceAuthRequest();
    const verificationUrl = new URL(paths.device.root, APP_URL);
    verificationUrl.searchParams.set("user_code", request.userCode);

    return NextResponse.json({
      device_code: request.deviceCode,
      user_code: request.userCode,
      verification_url: verificationUrl.toString(),
      expires_in: request.ttlSeconds,
      interval: request.pollIntervalSeconds,
    });
  } catch (error) {
    await serverLogger.error(error as Error, {
      context: "[CLI API] POST /api/cli/device/start failed",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
