// What /admin/billing needs that the ledger package deliberately does not
// hold: names.
//
// The ledger stores an account uuid and nothing else about the customer
// (cloud/docs/accounting-todo.md §2.1) — every field that names the person
// lives in `accounts` and cascades away on erasure. That is the right shape
// for books that must outlive the customer and must be movable to their own
// database, and it leaves one gap: a statement headed by a uuid is unusable
// for support.
//
// The decision (§8.10) is to resolve the label live and degrade to the bare
// uuid when the lookup finds nothing. Honest about what the books actually
// know, correct after an erasure, and it holds no identifying data past the
// moment the person asked for it to go. It also stops working the day
// accounting moves to its own database, which is the point at which a
// deliberate customer-label table becomes the answer — not before.

import { inArray } from "drizzle-orm";
import { accounts, type createDb } from "@frameos-cloud/db";

export type CustomerLabel = {
  accountId: string;
  email: string | null;
  // False when nothing in `accounts` matches: an erased customer, whose
  // books are still here and still theirs.
  known: boolean;
  name: string | null;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A uuid, from a query string or a form. Used to gate account ids and entry
// ids alike before they reach a query that casts them to ::uuid — a
// malformed one from the address bar should be an empty result, not a 500.
export function isAccountUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export async function resolveCustomerLabels(
  db: ReturnType<typeof createDb>,
  accountIds: (string | null | undefined)[],
): Promise<Map<string, CustomerLabel>> {
  const wanted = [...new Set(accountIds.filter(isAccountUuid))];
  const labels = new Map<string, CustomerLabel>(
    wanted.map((accountId) => [
      accountId,
      { accountId, email: null, known: false, name: null },
    ]),
  );
  if (wanted.length === 0) {
    return labels;
  }
  const rows = await db
    .select({
      displayName: accounts.displayName,
      id: accounts.id,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(inArray(accounts.id, wanted));
  for (const row of rows) {
    labels.set(row.id, {
      accountId: row.id,
      email: row.primaryEmail,
      known: true,
      name: row.displayName,
    });
  }
  return labels;
}

// The uuid a customer subaccount code carries, or null for a system account.
export function ownerOfAccountCode(code: string): string | null {
  const match = /:customer:([0-9a-f-]{36})$/i.exec(code);
  return match ? match[1]!.toLowerCase() : null;
}

// How a customer is named on screen. Never invents one: an erased account
// shows the uuid, which is exactly what the books still know about them.
export function describeCustomer(label: CustomerLabel | undefined, accountId: string): string {
  if (!label?.known) {
    return `${accountId.slice(0, 8)}… (deleted account)`;
  }
  return label.email ?? label.name ?? accountId;
}
