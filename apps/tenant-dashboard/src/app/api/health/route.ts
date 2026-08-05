import { NextResponse } from "next/server";
import { checkHealth, STATUS_CODE_MAP } from "@/lib/system/health";

export async function GET() {
  const health = await checkHealth();
  const statusCode = STATUS_CODE_MAP[health.status];

  return NextResponse.json(health, { status: statusCode });
}
