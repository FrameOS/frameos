import { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  getSuperadminContext,
  listAccountsForAdmin,
} from "../../../../src/lib/admin";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";

export async function GET(request: NextRequest) {
  const context = await getSuperadminContext();
  if (context.kind !== "ok") {
    return NextResponse.json(
      { error: context.kind },
      { status: context.kind === "unauthenticated" ? 401 : 403 },
    );
  }

  assertDatabaseUrlConfigured();
  const users = await listAccountsForAdmin(
    createDb(),
    request.nextUrl.searchParams.get("q") ?? undefined,
  );
  return NextResponse.json({ users });
}
