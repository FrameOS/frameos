import { eq, sql } from "drizzle-orm";
import { aiUsageRecords, ledgerEntries } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountBalanceMicros,
  billingSettingKeys,
  checkLedgerIntegrity,
  checkMeteringCompleteness,
  customerCreditsCode,
  postUsageRecord,
  recordAiUsage,
  sweepUnpostedUsage,
  systemAccountCodes,
  writeBillingSetting,
  type CredentialSource,
} from "../../index";
import { createAccount, db, resetLedger } from "./helpers";

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await resetLedger();
});

async function goLive() {
  await writeBillingSetting(db, billingSettingKeys.aiMeteringMode, "live");
}

// The design doc's worked turn: 40k uncached input + 12k cached + 30k
// output on terra. The provider reports 52,000 input tokens, cached
// included; splitting them is metering's job.
function turn(
  accountId: string | null,
  turnId: string,
  credentialSource: CredentialSource = "platform",
) {
  return {
    accountId,
    chatId: null,
    credentialSource,
    model: "gpt-5.6-terra",
    rounds: 3,
    surface: "scene_chat",
    turnId,
    usage: {
      cachedInputTokens: 12_000,
      inputTokens: 52_000,
      outputTokens: 30_000,
      reasoningTokens: 8_000,
    },
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("AI metering", () => {
  // Phase 2 ships in shadow mode: every turn is measured and priced, and
  // nothing at all reaches the journal. This is the state a week of
  // production runs in before anybody is charged a cent.
  it("measures and prices a turn in shadow mode without posting anything", async () => {
    const accountId = await createAccount();
    const result = await recordAiUsage(db, turn(accountId, uuid(1)));

    expect(result.posted).toBe(false);
    expect(result.record.meteringMode).toBe("shadow");
    expect(result.record.costMicros).toBe(442_400n);
    expect(result.record.priceMicros).toBe(575_120n);
    // Cached input separated out of the provider's total, reasoning kept as
    // the subset of output it is.
    expect(result.record.usage).toEqual({
      cachedInputTokens: 12_000,
      inputTokens: 40_000,
      outputTokens: 30_000,
      reasoningTokens: 8_000,
    });
    expect(await db.select().from(ledgerEntries)).toHaveLength(0);

    // And the sweep never comes back for it: a shadow row is measurement,
    // not a posting that failed.
    expect(await sweepUnpostedUsage(db, { olderThan: new Date(Date.now() + 1_000) })).toMatchObject({
      posted: 0,
      scanned: 0,
    });
    expect(await checkMeteringCompleteness(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  it("posts the charge and the cost once the switch is flipped", async () => {
    await goLive();
    const accountId = await createAccount();
    const result = await recordAiUsage(db, turn(accountId, uuid(2)));

    expect(result.posted).toBe(true);
    expect(result.entries.map((entry) => entry.entryType)).toEqual([
      "ai_usage_charge",
      "ai_usage_cost",
    ]);
    // The customer's credit account goes negative — they have not bought any
    // yet, and Phase 3's spend gate is what stops that happening for real.
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(
      -575_120n,
    );
    expect(await accountBalanceMicros(db, systemAccountCodes.revenueAiUsage)).toBe(
      575_120n,
    );
    expect(await accountBalanceMicros(db, systemAccountCodes.cogsOpenai)).toBe(
      442_400n,
    );
    expect(await accountBalanceMicros(db, systemAccountCodes.accruedOpenai)).toBe(
      442_400n,
    );
    // Margin is never stored: it is what the two entries leave between them.
    expect(575_120n - 442_400n).toBe(132_720n);

    const [row] = await db
      .select()
      .from(aiUsageRecords)
      .where(eq(aiUsageRecords.turnId, uuid(2)));
    expect(row?.eventId).toBe(result.entries[0] ? result.record.eventId : null);
    expect(row?.eventId).not.toBeNull();
  });

  // A turn on the customer's own key: measured, because "how much AI is this
  // account using" is worth answering whoever paid, and posted nowhere,
  // because nothing moved.
  it("records an own-key turn and posts nothing for it, ever", async () => {
    await goLive();
    const accountId = await createAccount();
    const result = await recordAiUsage(db, turn(accountId, uuid(3), "account"));

    expect(result.posted).toBe(false);
    expect(result.record.costMicros).toBe(0n);
    expect(result.record.priceMicros).toBe(0n);
    expect(await db.select().from(ledgerEntries)).toHaveLength(0);
    expect(await sweepUnpostedUsage(db, { olderThan: new Date(Date.now() + 1_000) })).toMatchObject(
      { posted: 0, scanned: 0 },
    );
  });

  // The operator's shared key is a real bill we absorb: COGS, billed to
  // nobody.
  it("books the operator's shared key as cost with no charge", async () => {
    await goLive();
    const accountId = await createAccount();
    const result = await recordAiUsage(db, turn(accountId, uuid(4), "shared"));

    expect(result.entries.map((entry) => entry.entryType)).toEqual(["ai_usage_cost"]);
    expect(await accountBalanceMicros(db, systemAccountCodes.cogsOpenai)).toBe(442_400n);
    expect(await accountBalanceMicros(db, customerCreditsCode(accountId))).toBe(0n);
  });

  // onFinish firing twice for one turn — a resumed turn that finished after
  // its relay had already been told so — must not meter it twice.
  it("meters one turn once however many times it is reported", async () => {
    await goLive();
    const accountId = await createAccount();
    await recordAiUsage(db, turn(accountId, uuid(5)));
    const again = await recordAiUsage(db, turn(accountId, uuid(5)));

    expect(again.replayed).toBe(true);
    expect(await db.select().from(aiUsageRecords)).toHaveLength(1);
    expect(await db.select().from(ledgerEntries)).toHaveLength(2);
    expect(await accountBalanceMicros(db, systemAccountCodes.revenueAiUsage)).toBe(
      575_120n,
    );
  });

  // The failure this design exists for: the ledger write fails, the
  // measurement survives, and the sweep posts it later. At-least-once
  // delivery, exactly-once effect.
  it("keeps the record when posting fails and posts it on the next sweep", async () => {
    await goLive();
    const accountId = await createAccount();
    const result = await recordAiUsage(db, turn(accountId, uuid(6)), {
      // No rule for the event type: the post fails the way a broken recipe
      // or a database blip would.
      rules: {},
    });

    expect(result.posted).toBe(false);
    expect(result.postError).toBeDefined();
    const [pending] = await db
      .select()
      .from(aiUsageRecords)
      .where(eq(aiUsageRecords.turnId, uuid(6)));
    expect(pending?.eventId).toBeNull();
    expect(pending?.costMicros).toBe(442_400n);

    // Before the grace period the sweep leaves it alone — it may still be
    // mid-post in the request that made it.
    expect(await sweepUnpostedUsage(db)).toMatchObject({ posted: 0, scanned: 0 });
    // And the integrity check calls it out once it is genuinely overdue.
    const violations = await checkMeteringCompleteness(db, { pendingEventGraceMs: 0 });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain(uuid(6));

    const swept = await sweepUnpostedUsage(db, {
      olderThan: new Date(Date.now() + 1_000),
    });
    expect(swept).toMatchObject({ failures: [], posted: 1, scanned: 1 });
    expect(await accountBalanceMicros(db, systemAccountCodes.revenueAiUsage)).toBe(
      575_120n,
    );
    expect(await checkMeteringCompleteness(db, { pendingEventGraceMs: 0 })).toEqual([]);

    // Sweeping again is a replay, not a second charge.
    await sweepUnpostedUsage(db, { olderThan: new Date(Date.now() + 1_000) });
    expect(await accountBalanceMicros(db, systemAccountCodes.revenueAiUsage)).toBe(
      575_120n,
    );
  });

  // The stamp is the only part of posting that is not inside the kernel's
  // transaction, so it is the one that can be lost on its own.
  it("re-stamps a record whose event was posted but never written back", async () => {
    await goLive();
    const accountId = await createAccount();
    await recordAiUsage(db, turn(accountId, uuid(7)));
    await db
      .update(aiUsageRecords)
      .set({ eventId: null })
      .where(eq(aiUsageRecords.turnId, uuid(7)));

    const [row] = await db
      .select()
      .from(aiUsageRecords)
      .where(eq(aiUsageRecords.turnId, uuid(7)));
    const posted = await postUsageRecord(db, row!);

    expect(posted.entries).toHaveLength(2);
    // Replayed, so nothing was posted a second time.
    expect(await db.select().from(ledgerEntries)).toHaveLength(2);
    const [restamped] = await db
      .select()
      .from(aiUsageRecords)
      .where(eq(aiUsageRecords.turnId, uuid(7)));
    expect(restamped?.eventId).toBe(posted.eventId);
  });

  // Flipping the switch must not retroactively bill the shadow period: the
  // mode is stamped per record, so backfilling that week stays a deliberate
  // act rather than a side effect of a settings change.
  it("never posts shadow rows written before the switch was flipped", async () => {
    const accountId = await createAccount();
    await recordAiUsage(db, turn(accountId, uuid(8)));
    await goLive();
    await recordAiUsage(db, turn(accountId, uuid(9)));

    const swept = await sweepUnpostedUsage(db, {
      olderThan: new Date(Date.now() + 1_000),
    });
    expect(swept.scanned).toBe(0);
    expect(await accountBalanceMicros(db, systemAccountCodes.revenueAiUsage)).toBe(
      575_120n,
    );
  });

  it("prices at the row in force when the turn ran, not at today's", async () => {
    await goLive();
    const accountId = await createAccount();
    await db.execute(sql`
      insert into ai_model_prices
        (model, input_micros_per_mtok, cached_input_micros_per_mtok, output_micros_per_mtok, effective_from)
      values ('gpt-5.6-terra', 4000000, 400000, 24000000, '2026-09-01T00:00:00Z')
    `);

    const before = await recordAiUsage(db, {
      ...turn(accountId, uuid(10)),
      occurredAt: new Date("2026-08-15T00:00:00Z"),
    });
    const after = await recordAiUsage(db, {
      ...turn(accountId, uuid(11)),
      occurredAt: new Date("2026-09-15T00:00:00Z"),
    });

    expect(before.record.costMicros).toBe(442_400n);
    expect(after.record.costMicros).toBe(884_800n);
  });

  // A model nobody priced must not meter free — that would hide the whole of
  // its spend — and the entry has to say the number was a guess.
  it("falls back to an estimated price for an unpriced model, and says so", async () => {
    await goLive();
    const accountId = await createAccount();
    const result = await recordAiUsage(db, {
      ...turn(accountId, uuid(12)),
      model: "gpt-9.9-unreleased",
    });

    expect(result.record.costMicros).toBeGreaterThan(0n);
    expect(result.entries[0]?.metadata).toMatchObject({
      pricing: { priceSource: "fallback" },
    });
  });

  it("leaves the books consistent after everything above", async () => {
    await goLive();
    const accountId = await createAccount();
    await recordAiUsage(db, turn(accountId, uuid(13)));
    await recordAiUsage(db, turn(accountId, uuid(14), "shared"));
    await recordAiUsage(db, turn(accountId, uuid(15), "account"));

    expect(
      await checkLedgerIntegrity(db, {
        // The customer bought no credits, so their balance is legitimately
        // negative here; Phase 3's gate is what stops that in production.
        overdraftMicros: 10_000_000n,
        pendingEventGraceMs: 0,
      }),
    ).toEqual([]);
  });
});
