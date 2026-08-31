import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  accountIdentities,
  accounts,
  connectedBackends,
  consentEvents,
  deviceAuthorizationRequests,
  financialEvents,
  ledgerAccountGroups,
  ledgerAccounts,
  ledgerBalances,
  ledgerEntries,
  ledgerPostings,
  linkedClients,
  auditEvents,
} from "./schema";

describe("cloud schema", () => {
  it("exports the current account and backend-linking tables", () => {
    expect(accounts).toBeDefined();
    expect(accountIdentities).toBeDefined();
    expect(linkedClients).toBeDefined();
    expect(connectedBackends).toBeDefined();
    expect(deviceAuthorizationRequests).toBeDefined();
    expect(consentEvents).toBeDefined();
    expect(auditEvents).toBeDefined();
  });

  it("exports the accounting ledger tables", () => {
    expect(financialEvents).toBeDefined();
    expect(ledgerAccountGroups).toBeDefined();
    expect(ledgerAccounts).toBeDefined();
    expect(ledgerEntries).toBeDefined();
    expect(ledgerPostings).toBeDefined();
    expect(ledgerBalances).toBeDefined();
  });

  it("keeps money columns as bigint micro-dollars", () => {
    expect(ledgerPostings.amountMicros.getSQLType()).toBe("bigint");
    expect(ledgerBalances.balanceMicros.getSQLType()).toBe("bigint");
  });

  // The ledger holds account uuids but references nothing outside itself, so
  // deleting an account can neither cascade its books away nor null the id
  // that says whose they were — a provider-cost entry touches no customer
  // account and would otherwise become attributable to nobody. It also keeps
  // the module movable to its own database.
  it("points no foreign key out of the ledger", () => {
    const ledgerTables = [
      financialEvents,
      ledgerAccountGroups,
      ledgerAccounts,
      ledgerEntries,
      ledgerPostings,
      ledgerBalances,
    ];
    const ledgerTableNames = new Set(
      ledgerTables.map((table) => getTableConfig(table).name),
    );
    for (const table of ledgerTables) {
      const outward = getTableConfig(table)
        .foreignKeys.map((key) => getTableConfig(key.reference().foreignTable).name)
        .filter((name) => !ledgerTableNames.has(name));
      expect(outward).toEqual([]);
    }
    // The uuid columns are still there — unreferenced, not removed.
    expect(financialEvents.accountId.getSQLType()).toBe("uuid");
    expect(ledgerAccounts.ownerAccountId.getSQLType()).toBe("uuid");
    expect(accounts.id.getSQLType()).toBe("uuid");
  });
});
