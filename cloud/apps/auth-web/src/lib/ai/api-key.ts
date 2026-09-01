// Which OpenAI key an AI chat request runs on. The account's own key
// (Settings -> OpenAI -> "API key for AI chat") always wins. Without one, the
// deployment's OPENAI_API_KEY can stand in — but only for the accounts the
// operator opted in, because a shared key is a shared bill:
//
//   FRAMEOS_AI_SHARED_KEY_ACCESS = none (default) | superadmin | verified | all
//
// "verified" covers superadmins too (they can verify themselves). The same
// env key already pays for store moderation/classification, so nothing new
// is provisioned; this only widens who it serves.
import { eq } from "drizzle-orm";
import {
  accountAiSpendMicros,
  readBillingSettings,
  surfaceIsAbsorbed,
  utcDayWindow,
} from "@frameos-cloud/ledger";
import { accounts, accountSettings, type createDb } from "@frameos-cloud/db";
import { resolveChatModel, resolveReasoningEffort } from "./openai";

export type AiCredentials = {
  apiKey: string;
  model: string;
  reasoningEffort: string;
  source: "account" | "shared";
};

// Why a turn was refused. Three different situations that used to collapse
// into one null, and telling a user who switched AI off that they should go
// set an API key is exactly the dead end the switch exists to avoid
// (cloud/docs/accounting-todo.md §5.1).
export type AiRefusal =
  // The account turned AI off. Nothing is wrong; they asked for this.
  | { detail: string; reason: "ai_disabled" }
  // Today's spend is at the cap. Comes back tomorrow on its own.
  | { detail: string; reason: "daily_cap_reached"; resetAt: string; capMicros: string; spentMicros: string }
  // No key available to this account at all — the original meaning of null.
  | { detail: string; reason: "missing_api_key" };

// What the cap looked like when the turn was let through, for the runner
// to keep checking against while the turn runs. Absent when no cap applies
// (their own key, an absorbed surface, a deployment with no cap).
export type AiSpendBudget = {
  capMicros: bigint;
  overdraftMicros: bigint;
  spentMicros: bigint;
};

export type AiAccess =
  | { budget?: AiSpendBudget; credentials: AiCredentials; ok: true }
  | { ok: false; refusal: AiRefusal };

type SharedAccess = "none" | "superadmin" | "verified" | "all";

export function sharedKeyAccess(env: Record<string, string | undefined> = process.env): SharedAccess {
  const raw = (env.FRAMEOS_AI_SHARED_KEY_ACCESS ?? "none").trim().toLowerCase();
  return raw === "superadmin" || raw === "verified" || raw === "all" ? raw : "none";
}

export function sharedKeyAllowedFor(
  account: { isSuperadmin: boolean; verifiedPublisherAt: Date | null },
  access: SharedAccess,
): boolean {
  switch (access) {
    case "all":
      return true;
    case "verified":
      return account.isSuperadmin || account.verifiedPublisherAt !== null;
    case "superadmin":
      return account.isSuperadmin;
    default:
      return false;
  }
}

/**
 * The one door every AI surface goes through, and therefore the one place
 * the AI switch and the daily cap can be enforced without relying on nobody
 * forgetting them at a call site added next month.
 *
 * Order matters: the switch first (an account that opted out must not have
 * its spend queried, let alone be told about a cap), then the key, then the
 * cap — which only binds when the key is OURS, because a turn on the
 * customer's own key costs us nothing and capping it would be gratuitous.
 */
export async function resolveAiAccess(
  db: ReturnType<typeof createDb>,
  accountId: string,
  options: {
    env?: Record<string, string | undefined> | undefined;
    // The product surface, so an absorbed one (the legacy scene converter,
    // which we pay for on purpose) is never turned into a 402 by a cap.
    surface?: string | null | undefined;
  } = {},
): Promise<AiAccess> {
  const env = options.env ?? process.env;
  const [account] = await db
    .select({ aiDisabledAt: accounts.aiDisabledAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (account?.aiDisabledAt) {
    return {
      ok: false,
      refusal: {
        detail:
          "AI features are switched off for this account. Turn them back on under Account → AI usage.",
        reason: "ai_disabled",
      },
    };
  }

  const credentials = await resolveAiCredentials(db, accountId, env);
  if (!credentials) {
    return {
      ok: false,
      refusal: {
        detail: "OpenAI backend API key not set",
        reason: "missing_api_key",
      },
    };
  }
  // Their key, their bill: no cap, and no query to run.
  if (credentials.source === "account" || surfaceIsAbsorbed(options.surface)) {
    return { credentials, ok: true };
  }

  const settings = await readBillingSettings(db, env);
  if (settings.dailyCapMicros > 0n) {
    const window = utcDayWindow();
    const spent = await accountAiSpendMicros(db, accountId, window);
    // Refused AT the cap. A turn's cost is unknown until it ends, so a turn
    // let through here can still cross the line; `payg_overdraft_micros` is
    // how far past it the runner lets that turn go before stopping it
    // mid-flight, and the tolerance the nightly check allows. The gate used
    // to refuse at cap + overdraft, which made the real cap $11 and every
    // honest overshoot a nightly alert (§9.2 item 3).
    if (spent >= settings.dailyCapMicros) {
      return {
        ok: false,
        refusal: {
          capMicros: settings.dailyCapMicros.toString(),
          detail:
            "This account has reached its daily AI limit. It resets at midnight UTC.",
          reason: "daily_cap_reached",
          resetAt: window.until.toISOString(),
          spentMicros: spent.toString(),
        },
      };
    }
    return {
      budget: {
        capMicros: settings.dailyCapMicros,
        overdraftMicros: settings.overdraftMicros,
        spentMicros: spent,
      },
      credentials,
      ok: true,
    };
  }
  return { credentials, ok: true };
}

export async function resolveAiCredentials(
  db: ReturnType<typeof createDb>,
  accountId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AiCredentials | null> {
  const settingsRows = await db
    .select()
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  const raw = settingsRows.find((row) => row.key === "openAI")?.value;
  const openaiSettings =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const model = resolveChatModel(openaiSettings);
  const reasoningEffort = resolveReasoningEffort(openaiSettings);

  const ownKey = openaiSettings.backendApiKey;
  if (typeof ownKey === "string" && ownKey.trim()) {
    return { apiKey: ownKey.trim(), model, reasoningEffort, source: "account" };
  }

  const sharedKey = env.OPENAI_API_KEY?.trim();
  const access = sharedKeyAccess(env);
  if (!sharedKey || access === "none") {
    return null;
  }
  const [account] = await db
    .select({
      isSuperadmin: accounts.isSuperadmin,
      verifiedPublisherAt: accounts.verifiedPublisherAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account || !sharedKeyAllowedFor(account, access)) {
    return null;
  }
  return { apiKey: sharedKey, model, reasoningEffort, source: "shared" };
}
