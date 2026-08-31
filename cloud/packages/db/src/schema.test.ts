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

  // Books survive account deletion: the delete route removes the accounts row
  // and relies on cascades, so a financial row that cascaded would take the
  // revenue it recorded with it, and a row that restricted would break
  // self-serve erasure outright. Both references null out instead.
  it("never cascades account deletion into the ledger", () => {
    for (const table of [financialEvents, ledgerAccounts]) {
      const [reference] = getTableConfig(table).foreignKeys.filter((key) =>
        key.reference().foreignTable === accounts,
      );
      expect(reference?.onDelete).toBe("set null");
    }
  });
});
