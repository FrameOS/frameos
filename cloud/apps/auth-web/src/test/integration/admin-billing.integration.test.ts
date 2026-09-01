// The admin books: posting to the journal by hand, changing the billing
// settings, and the nightly job. The ledger package proves the accounting;
// this proves the routes in front of it — who may call them, what they
// refuse, and that every one of them leaves an audit trail.
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  accounts,
  auditEvents,
  createDb,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import {
  accountBalanceMicros,
  billingSettingKeys,
  customerCreditsCode,
  customerReceivableCode,
  listJournalEntries,
  readBillingSettings,
  recordAiUsage,
  systemAccountCodes,
  writeBillingSetting,
} from "@frameos-cloud/ledger";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postGroups } from "../../../app/api/admin/billing/groups/route";
import { POST as postJournal } from "../../../app/api/admin/billing/journal/route";
import { POST as postNightly } from "../../../app/api/admin/billing/nightly/route";
import { POST as postSettings } from "../../../app/api/admin/billing/settings/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(),
}));

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

// The shared truncation takes the migration's seeded chart with it, so the
// system accounts are re-created here. ensureLedgerAccount does the same
// thing on first touch in production; this only spares each test from
// discovering that in a different order.
async function seedChart() {
  await db.execute(sql`
    INSERT INTO ledger_account_groups ("code", "name", "sort_order") VALUES
      ('assets', 'Assets', 10), ('liabilities', 'Liabilities', 20),
      ('equity', 'Equity', 30), ('revenue', 'Revenue', 40),
      ('cost_of_revenue', 'Cost of revenue', 50),
      ('operating_expenses', 'Operating expenses', 60)
    ON CONFLICT ("code") DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO ledger_accounts ("code", "type", "normal_side", "group_id")
    SELECT v.code, v.type, v.normal_side, g.id FROM (VALUES
      ('asset:psp:main', 'asset', 'debit', 'assets'),
      ('asset:bank:main', 'asset', 'debit', 'assets'),
      ('liability:deferred:subscriptions', 'liability', 'credit', 'liabilities'),
      ('liability:refunds_payable', 'liability', 'credit', 'liabilities'),
      ('liability:accrued:openai', 'liability', 'credit', 'liabilities'),
      ('revenue:ai_usage', 'revenue', 'credit', 'revenue'),
      ('revenue:subscriptions', 'revenue', 'credit', 'revenue'),
      ('contra_revenue:promo', 'contra_revenue', 'debit', 'revenue'),
      ('expense:cogs:openai', 'expense', 'debit', 'cost_of_revenue'),
      ('expense:psp_fees', 'expense', 'debit', 'cost_of_revenue')
    ) AS v(code, type, normal_side, group_code)
    JOIN ledger_account_groups g ON g.code = v.group_code
    ON CONFLICT ("code") DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO ai_model_prices
      ("model", "input_micros_per_mtok", "cached_input_micros_per_mtok", "output_micros_per_mtok", "effective_from")
    VALUES ('gpt-5.6-terra', 2000000, 200000, 12000000, '1970-01-01T00:00:00Z')
    ON CONFLICT ("model", "effective_from") DO NOTHING
  `);
}

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  if (names.length > 0) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
  }
  await seedChart();
});

function postJson(path: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl },
    method: "POST",
  });
}

async function signIn({ superadmin = false } = {}) {
  userCounter += 1;
  const providerSubject = `billing-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Billing Tester ${userCounter}`,
    email: `billing-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  if (superadmin) {
    await db
      .update(accounts)
      .set({ isSuperadmin: true })
      .where(eq(accounts.id, accountId));
  }
  const token = await createSession(db, {
    accountId,
    providerIssuer: issuer,
    providerSubject,
  });
  cookieJar.set(sessionCookieName, token);
  return accountId;
}

function journalLegs(customerCode: string, dollars = "10000000") {
  return [
    { accountCode: systemAccountCodes.psp, amountMicros: dollars, direction: "debit" },
    { accountCode: customerCode, amountMicros: dollars, direction: "credit" },
  ];
}

describe("admin billing routes", () => {
  it("are superadmin only", async () => {
    const accountId = await signIn();
    for (const [handler, path] of [
      [postJournal, "/api/admin/billing/journal"],
      [postSettings, "/api/admin/billing/settings"],
      [postGroups, "/api/admin/billing/groups"],
      [postNightly, "/api/admin/billing/nightly"],
    ] as const) {
      const response = await handler(postJson(path, { reason: "no" }));
      expect(response.status).toBe(403);
    }
    // And the account is still nobody's superadmin afterwards.
    const [row] = await db
      .select({ isSuperadmin: accounts.isSuperadmin })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(row?.isSuperadmin).toBe(false);
  });

  it("posts a manual journal, and records who asked for it and why", async () => {
    const customer = await signIn();
    const admin = await signIn({ superadmin: true });
    const response = await postJournal(
      postJson("/api/admin/billing/journal", {
        accountId: customer,
        action: "manual_journal",
        legs: journalLegs(customerCreditsCode(customer)),
        reason: "Bank transfer received, credited by hand",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      entries: { entry_type: string; total_micros: string }[];
    };
    // The entry's size is its debit side, not both sides added together.
    expect(payload.entries).toEqual([
      { entry_type: "manual_journal", id: expect.any(String), total_micros: "10000000" },
    ]);
    expect(await accountBalanceMicros(db, customerCreditsCode(customer))).toBe(
      10_000_000n,
    );

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "billing.manual_journal"));
    expect(audit?.accountId).toBe(customer);
    expect((audit?.actor as { accountId?: string })?.accountId).toBe(admin);
    expect((audit?.metadata as { reason?: string })?.reason).toBe(
      "Bank transfer received, credited by hand",
    );
  });

  // The books have to say why. An admin who cannot be bothered to type a
  // reason is exactly the entry somebody will be trying to explain later.
  it("refuses an entry with no reason, and one that does not balance", async () => {
    const customer = await signIn();
    await signIn({ superadmin: true });

    const noReason = await postJournal(
      postJson("/api/admin/billing/journal", {
        action: "manual_journal",
        legs: journalLegs(customerCreditsCode(customer)),
        reason: "   ",
      }),
    );
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error).toBe("reason_required");

    const unbalanced = await postJournal(
      postJson("/api/admin/billing/journal", {
        action: "manual_journal",
        legs: [
          { accountCode: systemAccountCodes.psp, amountMicros: "10000000", direction: "debit" },
          {
            accountCode: customerCreditsCode(customer),
            amountMicros: "9000000",
            direction: "credit",
          },
        ],
        reason: "Ten in, nine out",
      }),
    );
    expect(unbalanced.status).toBe(400);
    const body = await unbalanced.json();
    expect(body.error).toBe("entry_unbalanced");
    // The ledger's own words, which are the useful ones.
    expect(body.detail).toContain("out of balance");
    expect(await listJournalEntries(db)).toHaveLength(0);
  });

  it("reverses an entry rather than editing it, and refuses to do it twice", async () => {
    const customer = await signIn();
    await signIn({ superadmin: true });
    const posted = await postJournal(
      postJson("/api/admin/billing/journal", {
        accountId: customer,
        action: "manual_journal",
        legs: journalLegs(customerCreditsCode(customer)),
        reason: "Credited the wrong customer",
      }),
    );
    const entryId = (await posted.json()).entries[0].id as string;

    const reversal = await postJournal(
      postJson("/api/admin/billing/journal", {
        accountId: customer,
        action: "reverse",
        entryId,
        reason: "Wrong customer",
      }),
    );
    expect(reversal.status).toBe(200);
    expect(await accountBalanceMicros(db, customerCreditsCode(customer))).toBe(0n);
    // Both halves stay in the journal: the correction is visible, not applied.
    expect((await listJournalEntries(db)).map((entry) => entry.entryType)).toEqual([
      "manual_journal_reversal",
      "manual_journal",
    ]);

    const again = await postJournal(
      postJson("/api/admin/billing/journal", {
        action: "reverse",
        entryId,
        reason: "Wrong customer",
      }),
    );
    expect((await again.json()).replayed).toBe(true);
    expect(await listJournalEntries(db)).toHaveLength(2);
  });

  it("moves an amount between accounts with a reclassification", async () => {
    const customer = await signIn();
    await signIn({ superadmin: true });
    await postJournal(
      postJson("/api/admin/billing/journal", {
        accountId: customer,
        action: "manual_journal",
        legs: [
          {
            accountCode: customerCreditsCode(customer),
            amountMicros: "1000000",
            direction: "debit",
          },
          {
            accountCode: systemAccountCodes.revenueAiUsage,
            amountMicros: "1000000",
            direction: "credit",
          },
        ],
        reason: "Usage charge",
      }),
    );

    const response = await postJournal(
      postJson("/api/admin/billing/journal", {
        action: "reclassify",
        amountMicros: "400000",
        creditAccountCode: systemAccountCodes.revenueSubscriptions,
        debitAccountCode: systemAccountCodes.revenueAiUsage,
        reason: "Part of this was a plan fee",
      }),
    );
    expect(response.status).toBe(200);
    expect(await accountBalanceMicros(db, systemAccountCodes.revenueAiUsage)).toBe(
      600_000n,
    );
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
    ).toBe(400_000n);
  });

  it("writes billing settings, refuses nonsense, and audits both", async () => {
    const admin = await signIn({ superadmin: true });

    const bad = await postSettings(
      postJson("/api/admin/billing/settings", {
        settings: { ai_margin_percent: "not a number" },
      }),
    );
    expect(bad.status).toBe(400);
    // A typo'd setting must fail where a human can see it, not fall back to
    // the default silently on every read for a month.
    expect((await bad.json()).detail).toContain("percentage");

    const unknown = await postSettings(
      postJson("/api/admin/billing/settings", { settings: { rm_rf: true } }),
    );
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("unknown_setting");

    const ok = await postSettings(
      postJson("/api/admin/billing/settings", {
        settings: { ai_margin_percent: "42.5", ai_metering_mode: "live" },
      }),
    );
    expect(ok.status).toBe(200);
    const settings = await readBillingSettings(db, {});
    expect(settings.marginBasisPoints).toBe(4_250);
    expect(settings.meteringMode).toBe("live");

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "billing.settings_updated"));
    expect((audit?.actor as { accountId?: string })?.accountId).toBe(admin);
  });

  it("re-buckets an account for reporting without touching a posting", async () => {
    await signIn({ superadmin: true });
    const created = await postGroups(
      postJson("/api/admin/billing/groups", {
        action: "create",
        code: "platform_revenue",
        name: "Platform revenue",
      }),
    );
    expect(created.status).toBe(200);
    const groupId = (await created.json()).group.id as string;

    const [account] = await db.execute<{ id: string }>(
      sql`select id::text as id from ledger_accounts where code = 'revenue:ai_usage'`,
    );
    const assigned = await postGroups(
      postJson("/api/admin/billing/groups", {
        action: "assign",
        groupId,
        ledgerAccountId: account!.id,
      }),
    );
    expect(assigned.status).toBe(200);

    const [row] = await db.execute<{ code: string }>(sql`
      select g.code from ledger_accounts a
        join ledger_account_groups g on g.id = a.group_id
       where a.code = 'revenue:ai_usage'
    `);
    expect(row?.code).toBe("platform_revenue");
  });

  it("sweeps unposted usage and reports the invariants", async () => {
    const customer = await signIn();
    await signIn({ superadmin: true });
    await writeBillingSetting(db, billingSettingKeys.aiMeteringMode, "live");

    // A turn whose ledger write failed: the record survives, the entries do
    // not, and the sweep is what closes the gap.
    await recordAiUsage(
      db,
      {
        accountId: customer,
        credentialSource: "platform",
        model: "gpt-5.6-terra",
        rounds: 1,
        surface: "scene_chat",
        turnId: "00000000-0000-4000-8000-0000000000f1",
        usage: { cachedInputTokens: 12_000, inputTokens: 52_000, outputTokens: 30_000 },
      },
      { rules: {} },
    );
    await db.execute(
      sql`update ai_usage_records set created_at = now() - interval '1 hour'`,
    );

    const response = await postNightly(postJson("/api/admin/billing/nightly", {}));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.sweep).toMatchObject({ failed: 0, posted: 1, scanned: 1 });
    expect(await accountBalanceMicros(db, systemAccountCodes.revenueAiUsage)).toBe(
      575_120n,
    );
    // Postpay: the charge is an ordinary debit to what the customer owes us,
    // so there is nothing irregular about the books at all — and half a
    // dollar is well inside the $10 daily cap.
    expect(payload).toMatchObject({ ok: true, violations: [] });
    expect(
      await accountBalanceMicros(db, customerReceivableCode(customer)),
    ).toBe(575_120n);

    // Drop the cap under what the day already spent and the same turn becomes
    // the violation the nightly job exists to shout about. This is invariant
    // 5's postpay replacement, and the reason it matters is that it is the
    // only automated proof the spend gate sits in front of every AI surface
    // rather than most of them.
    await writeBillingSetting(db, billingSettingKeys.paygOverdraftMicros, 0);
    await writeBillingSetting(db, billingSettingKeys.paygDailyCapMicros, 1);
    const strict = await postNightly(postJson("/api/admin/billing/nightly", {}));
    const strictPayload = await strict.json();
    expect(strictPayload.violations).toContainEqual({
      check: "daily_cap_respected",
      detail: expect.stringContaining(customer),
    });
    expect(strictPayload.ok).toBe(false);
    // And it reports rather than repairs: a book that disagrees with itself
    // needs a human, and a silent "correction" is how that goes unnoticed.
    expect(
      await accountBalanceMicros(db, customerReceivableCode(customer)),
    ).toBe(575_120n);
  });
});
