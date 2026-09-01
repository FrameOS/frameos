import { describe, expect, it } from "vitest";
import {
  customerCreditsCode,
  describeAccountCode,
  normalSideForType,
  systemAccountCodes,
} from "./chart";
import { LedgerError } from "./types";

const accountId = "5f1c1b3e-2c9a-4a1e-9d3b-6f4f1a2b3c4d";

describe("chart of accounts", () => {
  it("puts a positive balance on the side the account type implies", () => {
    expect(normalSideForType("asset")).toBe("debit");
    expect(normalSideForType("expense")).toBe("debit");
    expect(normalSideForType("liability")).toBe("credit");
    expect(normalSideForType("revenue")).toBe("credit");
    // Contra-revenue is revenue's mirror: promo grants reduce what we earned.
    expect(normalSideForType("contra_revenue")).toBe("debit");
  });

  it("describes system accounts", () => {
    expect(describeAccountCode(systemAccountCodes.revenueAiUsage)).toEqual({
      groupCode: "revenue",
      normalSide: "credit",
      ownerAccountId: null,
      type: "revenue",
    });
  });

  it("describes customer subaccounts and carries the owner", () => {
    expect(describeAccountCode(customerCreditsCode(accountId))).toEqual({
      groupCode: "liabilities",
      normalSide: "credit",
      ownerAccountId: accountId,
      type: "liability",
    });
  });

  // One customer, one account, whatever the casing: a code with an uppercase
  // uuid describes the same lowercase owner its canonical form does.
  it("lowercases the customer uuid", () => {
    expect(
      describeAccountCode(customerCreditsCode(accountId.toUpperCase()))
        .ownerAccountId,
    ).toBe(accountId);
  });

  // A typo in a posting rule must fail loudly rather than mint an account
  // nobody meant to exist and quietly park money in it.
  it("refuses codes it does not recognize", () => {
    expect(() => describeAccountCode("revenue:mystery")).toThrow(LedgerError);
    expect(() =>
      describeAccountCode("liability:credits:customer:not-a-uuid"),
    ).toThrow(LedgerError);
  });
});
