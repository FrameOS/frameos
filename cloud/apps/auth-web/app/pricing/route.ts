import { NextResponse } from "next/server";
import { getAccountSettingsUrl, getPricingUrl } from "../../src/lib/env";
import { readSession } from "../../src/lib/session";

export const runtime = "nodejs";

// There is no price list here. The public one is on the product site
// (getPricingUrl), and an account's own plans, with the buttons to buy or
// change one, are on its usage page. This address stays for the links that
// point at it.
export async function GET() {
  const session = await readSession();
  return NextResponse.redirect(
    session?.accountId ? getAccountSettingsUrl("usage") : getPricingUrl(),
    { headers: { "cache-control": "no-store" }, status: 307 },
  );
}
