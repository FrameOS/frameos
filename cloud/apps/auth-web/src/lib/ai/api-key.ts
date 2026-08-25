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
import { accounts, accountSettings, type createDb } from "@frameos-cloud/db";
import { resolveChatModel, resolveReasoningEffort } from "./openai";

export type AiCredentials = {
  apiKey: string;
  model: string;
  reasoningEffort: string;
  source: "account" | "shared";
};

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
