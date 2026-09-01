import { inArray } from "drizzle-orm";
import { billingSettings } from "@frameos-cloud/db";
import { LedgerError, type LedgerExecutor } from "./types";

// The knobs that change what metering does: the margin over provider cost,
// how far a customer may overdraw, and whether metering posts to the ledger
// at all. Rows in `billing_settings`, editable by a superadmin at
// /admin/billing, with a code-level default for every key so a database that
// has never been seeded still boots with sane numbers.
//
// Every value read here is snapshotted into the thing it decided — the
// margin into the usage record's `pricing`, the mode into `metering_mode` —
// so changing a setting never rewrites the meaning of what it already
// produced.

export const billingSettingKeys = {
  aiMarginPercent: "ai_margin_percent",
  aiMeteringMode: "ai_metering_mode",
  paygDailyCapMicros: "payg_daily_cap_micros",
  paygOverdraftMicros: "payg_overdraft_micros",
} as const;

export type BillingSettingKey =
  (typeof billingSettingKeys)[keyof typeof billingSettingKeys];

// 'shadow': measure and price every turn, post nothing. 'live': post.
// Phase 2 ships in shadow; Phase 3 flips it once a week of records has been
// checked against the provider's own invoice.
export type MeteringMode = "live" | "shadow";

export interface BillingSettings {
  // The ceiling on one account's chargeable AI usage in a UTC day (§5.3).
  // Postpay's credit limit, wearing a unit users think in.
  dailyCapMicros: bigint;
  marginBasisPoints: number;
  meteringMode: MeteringMode;
  overdraftMicros: bigint;
}

export const defaultBillingSettings: BillingSettings = {
  dailyCapMicros: 10_000_000n,
  marginBasisPoints: 3_000,
  meteringMode: "shadow",
  overdraftMicros: 1_000_000n,
};

export async function readBillingSettings(
  db: LedgerExecutor,
  env: Record<string, string | undefined> = process.env,
): Promise<BillingSettings> {
  const rows = await db
    .select()
    .from(billingSettings)
    .where(inArray(billingSettings.key, Object.values(billingSettingKeys)));
  const values = new Map(rows.map((row) => [row.key, row.value]));

  return {
    dailyCapMicros:
      microsFrom(values.get(billingSettingKeys.paygDailyCapMicros)) ??
      microsFrom(env.FRAMEOS_CLOUD_AI_DAILY_CAP_MICROS) ??
      defaultBillingSettings.dailyCapMicros,
    marginBasisPoints:
      marginBasisPointsFrom(values.get(billingSettingKeys.aiMarginPercent)) ??
      // Bootstrap for a deployment whose settings row has not been written
      // yet; the row wins once it exists.
      marginBasisPointsFrom(env.FRAMEOS_CLOUD_AI_MARGIN_PERCENT) ??
      defaultBillingSettings.marginBasisPoints,
    meteringMode:
      meteringModeFrom(values.get(billingSettingKeys.aiMeteringMode)) ??
      meteringModeFrom(env.FRAMEOS_CLOUD_AI_METERING_MODE) ??
      defaultBillingSettings.meteringMode,
    overdraftMicros:
      microsFrom(values.get(billingSettingKeys.paygOverdraftMicros)) ??
      defaultBillingSettings.overdraftMicros,
  };
}

export async function writeBillingSetting(
  db: LedgerExecutor,
  key: BillingSettingKey,
  value: unknown,
  updatedBy?: string | null | undefined,
): Promise<void> {
  // Validated on the way in, not on the way out: a typo'd setting must fail
  // where a human can see it, not silently fall back to the default on every
  // read for the next month.
  validateSetting(key, value);
  await db
    .insert(billingSettings)
    .values({ key, updatedBy: updatedBy ?? null, value })
    .onConflictDoUpdate({
      set: { updatedAt: new Date(), updatedBy: updatedBy ?? null, value },
      target: billingSettings.key,
    });
}

// The rows as stored, for the admin page: an audited setting is worth
// showing with who last touched it and when.
export async function readRawBillingSettings(
  db: LedgerExecutor,
): Promise<
  { key: string; updatedAt: Date; updatedBy: string | null; value: unknown }[]
> {
  return db.select().from(billingSettings);
}

function validateSetting(key: BillingSettingKey, value: unknown): void {
  switch (key) {
    case billingSettingKeys.aiMarginPercent:
      if (marginBasisPointsFrom(value) === undefined) {
        throw new LedgerError(
          "invalid_amount",
          "ai_margin_percent must be a percentage between 0 and 1000",
        );
      }
      return;
    case billingSettingKeys.aiMeteringMode:
      if (meteringModeFrom(value) === undefined) {
        throw new LedgerError(
          "invalid_draft",
          'ai_metering_mode must be "shadow" or "live"',
        );
      }
      return;
    case billingSettingKeys.paygDailyCapMicros:
      if (microsFrom(value) === undefined) {
        throw new LedgerError(
          "invalid_amount",
          "payg_daily_cap_micros must be a non-negative whole number of micro-dollars",
        );
      }
      return;
    case billingSettingKeys.paygOverdraftMicros:
      if (microsFrom(value) === undefined) {
        throw new LedgerError(
          "invalid_amount",
          "payg_overdraft_micros must be a non-negative whole number of micro-dollars",
        );
      }
      return;
  }
}

// Percent in, basis points out: "30" and "30.5" both work, and the result is
// an integer so no float ever reaches a money computation.
function marginBasisPointsFrom(value: unknown): number | undefined {
  const percent =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(percent) || percent < 0 || percent > 1000) {
    return undefined;
  }
  return Math.round(percent * 100);
}

function meteringModeFrom(value: unknown): MeteringMode | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "live" || raw === "shadow" ? raw : undefined;
}

function microsFrom(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return undefined;
}
