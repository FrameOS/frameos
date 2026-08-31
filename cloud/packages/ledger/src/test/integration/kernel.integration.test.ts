import { eq, sql } from "drizzle-orm";
import {
  accounts,
  financialEvents,
  ledgerAccounts,
  ledgerEntries,
  ledgerPostings,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountBalanceMicros,
  customerCreditsCode,
  dollarsToMicros,
  findUnpostedEvents,
  manualJournalEventType,
  postEvent,
  reverseEntry,
  systemAccountCodes,
  LedgerError,
} from "../../index";
import { createAccount, db, resetLedger } from "./helpers";

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await resetLedger();
});

// A $10 credit purchase, stated by hand: money arrives at Stripe, the
// customer's balance grows by the same amount.
function purchase(accountId: string, key: string, dollars = 10) {
  return {
    accountId,
    eventType: manualJournalEventType,
    idempotencyKey: key,
    payload: {
      description: "Prepaid credit purchase",
      externalRef: "pi_test_123",
      legs: [
        {
          accountCode: systemAccountCodes.pspStripe,
          amountMicros: dollarsToMicros(dollars).toString(),
          direction: "debit",
        },
        {
          accountCode: customerCreditsCode(accountId),
          amountMicros: dollarsToMicros(dollars).toString(),
          direction: "credit",
        },
      ],
    },
    source: "admin",
  };
}

// Drizzle wraps a driver error in its own "Failed query" error and keeps the
// database's message as the cause, so the trigger's own words are one link
// down the chain.
async function refusalMessage(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join(" | ");
  }
  throw new Error("Expected the database to refuse the query");
}

describe("posting kernel", () => {
  it("posts an event into balanced entries, postings and balances", async () => {
    const accountId = await createAccount();
    const result = await postEvent(db, purchase(accountId, "purchase:1"));

    expect(result.replayed).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(result.event.processedAt).toBeInstanceOf(Date);

    const [entry] = result.entries;
    expect(entry?.entryType).toBe("manual_journal");
    expect(entry?.ruleVersion).toBe(1);
    expect(entry?.externalRef).toBe("pi_test_123");
    expect(entry?.postings.map((posting) => posting.direction)).toEqual([
      "debit",
      "credit",
    ]);

    // Stripe holds ten dollars (an asset, positive on the debit side); we owe
    // the customer the same ten (a liability, positive on the credit side).
    expect(await accountBalanceMicros(db, systemAccountCodes.pspStripe)).toBe(
      10_000_000n,
    );
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      10_000_000n,
    );
  });

  // A manual journal carries account codes verbatim, so a leg naming the
  // customer uuid in uppercase must land in the existing lowercase account
  // rather than minting a sibling holding part of the balance.
  it("folds differently-cased spellings of one customer account together", async () => {
    const accountId = await createAccount();
    await postEvent(db, purchase(accountId, "purchase:1"));

    const shouted = purchase(accountId, "purchase:2", 5);
    shouted.payload.legs[1]!.accountCode = customerCreditsCode(
      accountId,
    ).replace(accountId, accountId.toUpperCase());
    const result = await postEvent(db, shouted);

    expect(result.entries[0]?.postings[1]?.accountCode).toBe(
      customerCreditsCode(accountId),
    );
    const rows = await db
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.ownerAccountId, accountId));
    expect(rows).toHaveLength(1);
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      15_000_000n,
    );
  });

  it("creates the customer subaccount on first touch and reuses it after", async () => {
    const accountId = await createAccount();
    await postEvent(db, purchase(accountId, "purchase:1"));
    await postEvent(db, purchase(accountId, "purchase:2", 5));

    const rows = await db
      .select({ ownerAccountId: ledgerAccounts.ownerAccountId })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.code, customerCreditsCode(accountId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerAccountId).toBe(accountId);
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      15_000_000n,
    );
  });

  // The webhook that fires twice, the sweep that re-posts what it thinks is
  // pending: replaying an event returns what the first call posted rather
  // than charging the customer again.
  it("replays an event without posting it twice", async () => {
    const accountId = await createAccount();
    const first = await postEvent(db, purchase(accountId, "purchase:1"));
    const second = await postEvent(db, purchase(accountId, "purchase:1"));

    expect(second.replayed).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(second.entries.map((entry) => entry.id)).toEqual([
      first.entries[0]?.id,
    ]);
    expect(await db.select().from(ledgerEntries)).toHaveLength(1);
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      10_000_000n,
    );
  });

  it("refuses one idempotency key standing for two different facts", async () => {
    const accountId = await createAccount();
    await postEvent(db, purchase(accountId, "purchase:1"));
    await expect(
      postEvent(db, {
        ...purchase(accountId, "purchase:1"),
        eventType: "ledger_entry.reversed",
      }),
    ).rejects.toThrow(/already belongs to a/);
  });

  it("writes nothing at all when the rule produces an unbalanced entry", async () => {
    const accountId = await createAccount();
    await expect(
      postEvent(db, {
        accountId,
        eventType: manualJournalEventType,
        idempotencyKey: "bad:1",
        payload: {
          description: "Ten in, nine out",
          legs: [
            {
              accountCode: systemAccountCodes.pspStripe,
              amountMicros: "10000000",
              direction: "debit",
            },
            {
              accountCode: customerCreditsCode(accountId),
              amountMicros: "9000000",
              direction: "credit",
            },
          ],
        },
        source: "admin",
      }),
    ).rejects.toThrow(LedgerError);

    // The event row is rolled back with the postings: a fact that produced no
    // entries must not be left behind claiming its idempotency key.
    expect(await db.select().from(financialEvents)).toHaveLength(0);
    expect(await db.select().from(ledgerPostings)).toHaveLength(0);
  });

  it("refuses an event type no rule knows", async () => {
    await expect(
      postEvent(db, {
        eventType: "something.unmodelled",
        idempotencyKey: "unknown:1",
        source: "admin",
      }),
    ).rejects.toThrow(/No posting rule/);
  });

  // Every customer's turn credits the same revenue account, so concurrent
  // postings contend on one balance row. The sum has to come out exact.
  it("keeps balances exact under concurrent posting to one account", async () => {
    const accountIds = await Promise.all(
      Array.from({ length: 8 }, () => createAccount()),
    );
    await Promise.all(
      accountIds.map((accountId, index) =>
        postEvent(db, purchase(accountId, `concurrent:${index}`, 1)),
      ),
    );

    expect(await accountBalanceMicros(db, systemAccountCodes.pspStripe)).toBe(
      8_000_000n,
    );
  });

  it("reverses an entry leg for leg, and only once", async () => {
    const accountId = await createAccount();
    const posted = await postEvent(db, purchase(accountId, "purchase:1"));
    const entryId = posted.entries[0]!.id;

    const reversal = await reverseEntry(db, {
      accountId,
      entryId,
      reason: "Chargeback",
      source: "admin",
    });

    const [entry] = reversal.entries;
    expect(entry?.entryType).toBe("manual_journal_reversal");
    expect(entry?.reversesEntryId).toBe(entryId);
    expect(entry?.postings.map((posting) => posting.direction)).toEqual([
      "credit",
      "debit",
    ]);
    // Reversed means back to zero, not "adjusted": both accounts are flat.
    expect(await accountBalanceMicros(db, systemAccountCodes.pspStripe)).toBe(0n);
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      0n,
    );

    // Reversing again is the same fact, so it replays instead of mirroring
    // the entry a second time.
    const again = await reverseEntry(db, {
      accountId,
      entryId,
      reason: "Chargeback",
      source: "admin",
    });
    expect(again.replayed).toBe(true);
    expect(await db.select().from(ledgerEntries)).toHaveLength(2);
  });

  // Purchases and refunds post inside the route's own transaction, so the
  // money row and the entry that explains it commit or fail together.
  it("posts inside a transaction the caller already opened", async () => {
    const accountId = await createAccount();
    await db.transaction(async (tx) => {
      await postEvent(tx, purchase(accountId, "purchase:1"));
    });
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      10_000_000n,
    );

    await expect(
      db.transaction(async (tx) => {
        await postEvent(tx, purchase(accountId, "purchase:2", 5));
        throw new Error("the caller changed its mind");
      }),
    ).rejects.toThrow(/changed its mind/);

    // The rolled-back purchase left nothing behind — not the entry, and not
    // the idempotency key that would make a retry look like a replay.
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      10_000_000n,
    );
    expect(await db.select().from(financialEvents)).toHaveLength(1);
  });

  it("refuses to reverse an entry that does not exist", async () => {
    await expect(
      reverseEntry(db, {
        entryId: "44444444-4444-4444-4444-444444444444",
        reason: "typo",
        source: "admin",
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("lists events that were never posted", async () => {
    const accountId = await createAccount();
    await postEvent(db, purchase(accountId, "purchase:1"));
    // A row an earlier attempt left behind: inserted, never posted.
    await db.insert(financialEvents).values({
      eventType: manualJournalEventType,
      idempotencyKey: "stranded:1",
      occurredAt: new Date(),
      payload: {},
      source: "cron",
    });

    const unposted = await findUnpostedEvents(db, new Date(Date.now() + 1_000));
    expect(unposted.map((event) => event.idempotencyKey)).toEqual([
      "stranded:1",
    ]);
  });

  // The database, not the kernel, is what makes history permanent.
  it("refuses to rewrite anything already posted", async () => {
    const accountId = await createAccount();
    const posted = await postEvent(db, purchase(accountId, "purchase:1"));
    const entryId = posted.entries[0]!.id;

    expect(
      await refusalMessage(
        db
          .update(ledgerEntries)
          .set({ description: "Something else" })
          .where(eq(ledgerEntries.id, entryId)),
      ),
    ).toMatch(/append-only/);
    expect(
      await refusalMessage(
        db.delete(ledgerPostings).where(eq(ledgerPostings.entryId, entryId)),
      ),
    ).toMatch(/append-only/);
    expect(
      await refusalMessage(
        db
          .update(financialEvents)
          .set({ payload: { tampered: true } })
          .where(eq(financialEvents.id, posted.event.id)),
      ),
    ).toMatch(/immutable/);
  });

  // GDPR erasure removes the person, not the books: the accounts row goes,
  // the entries stay, and the ledger still balances.
  it("survives the deletion of the account it billed", async () => {
    const accountId = await createAccount();
    await postEvent(db, purchase(accountId, "purchase:1"));

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const [event] = await db.select().from(financialEvents);
    expect(event?.accountId).toBeNull();
    expect(event?.processedAt).toBeInstanceOf(Date);
    // The customer's uuid lives on in the account code, which is what keeps
    // the balance attributable without keeping the person identifiable.
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      10_000_000n,
    );
    const counts = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from ledger_postings`,
    );
    expect(counts[0]?.count).toBe("2");
  });
});
