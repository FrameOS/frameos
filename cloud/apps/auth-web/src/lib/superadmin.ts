import { eq } from "drizzle-orm";
import { accounts, createDb } from "@frameos-cloud/db";
import { hasDatabaseUrl } from "./env";

// Whether the account behind a session is a superadmin — used by shells to
// decide whether to offer the Admin nav link.
export async function accountIsSuperadmin(
  accountId: string | undefined,
): Promise<boolean> {
  if (!accountId || !hasDatabaseUrl()) {
    return false;
  }
  const db = createDb();
  const [row] = await db
    .select({ isSuperadmin: accounts.isSuperadmin })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.isSuperadmin ?? false;
}
