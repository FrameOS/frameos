import { eq } from "drizzle-orm";
import { ledgerAccountGroups, ledgerAccounts } from "@frameos-cloud/db";
import {
  LedgerError,
  type LedgerAccountType,
  type LedgerExecutor,
  type PostingDirection,
} from "./types";

// The chart of accounts, as codes. Codes — not ids — are what posting rules
// name, what reports group by and what survives in the books after the
// customer behind a subaccount is erased. The system accounts below are
// seeded by migration 0042; the per-customer ones are created on first touch
// by ensureLedgerAccount.
export const systemAccountCodes = {
  accruedOpenai: "liability:accrued:openai",
  bank: "asset:bank:main",
  cogsOpenai: "expense:cogs:openai",
  deferredSubscriptions: "liability:deferred:subscriptions",
  promoContraRevenue: "contra_revenue:promo",
  pspFees: "expense:psp_fees",
  // The payment service provider is not chosen yet, so the account that
  // holds money sitting at it is named for the role, not the vendor.
  psp: "asset:psp:main",
  refundsPayable: "liability:refunds_payable",
  revenueAiUsage: "revenue:ai_usage",
  revenueSubscriptions: "revenue:subscriptions",
} as const;

// A customer's prepaid credit balance is not a separate commodity: it is the
// balance of this liability account, in dollars. "1 credit = $0.01" is a
// display choice the ledger knows nothing about.
export function customerCreditsCode(accountId: string): string {
  return `liability:credits:customer:${requireUuid(accountId)}`;
}

// Granted credits live apart from bought ones: they are not deferred revenue
// and they are excluded from refund math.
export function customerPromoCreditsCode(accountId: string): string {
  return `liability:credits_promo:customer:${requireUuid(accountId)}`;
}

export function customerReceivableCode(accountId: string): string {
  return `asset:receivable:customer:${requireUuid(accountId)}`;
}

export interface LedgerAccountDefinition {
  groupCode: string;
  normalSide: PostingDirection;
  ownerAccountId: string | null;
  type: LedgerAccountType;
}

const systemDefinitions: Record<string, LedgerAccountDefinition> = {
  [systemAccountCodes.accruedOpenai]: definition("liability", "liabilities"),
  [systemAccountCodes.bank]: definition("asset", "assets"),
  [systemAccountCodes.cogsOpenai]: definition("expense", "cost_of_revenue"),
  [systemAccountCodes.deferredSubscriptions]: definition(
    "liability",
    "liabilities",
  ),
  [systemAccountCodes.promoContraRevenue]: definition(
    "contra_revenue",
    "revenue",
  ),
  [systemAccountCodes.pspFees]: definition("expense", "cost_of_revenue"),
  [systemAccountCodes.psp]: definition("asset", "assets"),
  [systemAccountCodes.refundsPayable]: definition("liability", "liabilities"),
  [systemAccountCodes.revenueAiUsage]: definition("revenue", "revenue"),
  [systemAccountCodes.revenueSubscriptions]: definition("revenue", "revenue"),
};

const customerPrefixes: Record<string, Omit<LedgerAccountDefinition, "ownerAccountId">> =
  {
    "asset:receivable:customer:": {
      groupCode: "assets",
      normalSide: "debit",
      type: "asset",
    },
    "liability:credits:customer:": {
      groupCode: "liabilities",
      normalSide: "credit",
      type: "liability",
    },
    "liability:credits_promo:customer:": {
      groupCode: "liabilities",
      normalSide: "credit",
      type: "liability",
    },
  };

// A positive balance sits on an account's normal side, so the type decides
// it: what we own and what we spend grows on the debit side, what we owe and
// what we earn on the credit side. Contra-revenue is revenue's mirror and so
// takes the opposite side of its family.
export function normalSideForType(type: LedgerAccountType): PostingDirection {
  return type === "asset" || type === "expense" || type === "contra_revenue"
    ? "debit"
    : "credit";
}

// Every code the ledger accepts is either a known system account or a
// customer subaccount of a known shape. An unrecognized code is a typo in a
// posting rule, and typos must not silently mint accounts.
export function describeAccountCode(code: string): LedgerAccountDefinition {
  return resolveAccountCode(code).definition;
}

// The canonical spelling comes with the definition: a customer code carries
// its uuid lowercased, so the same customer can never appear under two
// casings of one account.
function resolveAccountCode(code: string): {
  canonicalCode: string;
  definition: LedgerAccountDefinition;
} {
  const system = systemDefinitions[code];
  if (system) {
    return { canonicalCode: code, definition: system };
  }
  for (const [prefix, shape] of Object.entries(customerPrefixes)) {
    if (code.startsWith(prefix)) {
      const ownerAccountId = requireUuid(code.slice(prefix.length));
      return {
        canonicalCode: `${prefix}${ownerAccountId}`,
        definition: { ...shape, ownerAccountId },
      };
    }
  }
  throw new LedgerError(
    "unknown_account_code",
    `${code} is not a known ledger account code`,
  );
}

export interface ResolvedLedgerAccount {
  code: string;
  currency: string;
  id: string;
  normalSide: PostingDirection;
}

// Finds the account behind a code, creating a customer subaccount the first
// time it is touched. Concurrent creation is safe: the unique index on code
// makes the loser of the race read the winner's row.
export async function ensureLedgerAccount(
  db: LedgerExecutor,
  code: string,
): Promise<ResolvedLedgerAccount> {
  const existing = await selectAccount(db, code);
  if (existing) {
    return existing;
  }

  // Everything from here on speaks the canonical spelling: a leg naming an
  // uppercase uuid must land in the same account as its lowercase self, not
  // mint a sibling holding part of the customer's balance.
  const { canonicalCode, definition } = resolveAccountCode(code);
  if (canonicalCode !== code) {
    const canonical = await selectAccount(db, canonicalCode);
    if (canonical) {
      return canonical;
    }
  }
  const [group] = await db
    .select({ id: ledgerAccountGroups.id })
    .from(ledgerAccountGroups)
    .where(eq(ledgerAccountGroups.code, definition.groupCode))
    .limit(1);

  await db
    .insert(ledgerAccounts)
    .values({
      code: canonicalCode,
      groupId: group?.id ?? null,
      normalSide: definition.normalSide,
      ownerAccountId: definition.ownerAccountId,
      type: definition.type,
    })
    .onConflictDoNothing({ target: ledgerAccounts.code });

  const created = await selectAccount(db, canonicalCode);
  if (!created) {
    throw new LedgerError(
      "unknown_account_code",
      `Failed to create ledger account ${canonicalCode}`,
    );
  }
  return created;
}

async function selectAccount(
  db: LedgerExecutor,
  code: string,
): Promise<ResolvedLedgerAccount | undefined> {
  const [row] = await db
    .select({
      code: ledgerAccounts.code,
      currency: ledgerAccounts.currency,
      id: ledgerAccounts.id,
      normalSide: ledgerAccounts.normalSide,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.code, code))
    .limit(1);
  return row
    ? { ...row, normalSide: row.normalSide as PostingDirection }
    : undefined;
}

function definition(
  type: LedgerAccountType,
  groupCode: string,
): LedgerAccountDefinition {
  return {
    groupCode,
    normalSide: normalSideForType(type),
    ownerAccountId: null,
    type,
  };
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new LedgerError(
      "unknown_account_code",
      `Customer ledger accounts are keyed on an account uuid, got ${JSON.stringify(value)}`,
    );
  }
  return value.toLowerCase();
}
