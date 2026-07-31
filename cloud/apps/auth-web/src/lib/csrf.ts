import { NextRequest, NextResponse } from "next/server";
import { getAppOrigins } from "./env";

export function csrfResponse(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return NextResponse.json({ error: "missing_origin" }, { status: 403 });
  }

  if (!getAppOrigins().has(origin)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  return undefined;
}
