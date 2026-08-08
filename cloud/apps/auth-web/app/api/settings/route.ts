import { eq } from "drizzle-orm";
import { accountSettings, createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  filterAccountSettings,
  type FilteredAccountSettings,
} from "../../../src/lib/account-settings";
import { recordAuditEvent } from "../../../src/lib/audit";
import { csrfResponse } from "../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../src/lib/rate-limit";
import { readSession } from "../../../src/lib/session";

export const runtime = "nodejs";

// Account-level service settings (Unsplash/OpenAI/Home Assistant/... API
// keys scenes use). Same wire shape as the backend's /api/settings
// (backend/app/api/settings.py) so the shared SPA's settingsLogic works
// unchanged in cloud mode: GET returns the merged {group: value} object,
// POST replaces each posted group wholesale and returns the updated merge.
// Which groups and fields are storable is the account-settings.ts allowlist.

async function storedAccountSettings(
  db: ReturnType<typeof createDb>,
  accountId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "settings:read", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  return NextResponse.json(
    await storedAccountSettings(db, session.accountId),
  );
}

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "settings:write", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const body = await readJsonObject(request);
  const filtered = filterAccountSettings(body);
  if (filtered.error || !filtered.settings) {
    return jsonError(filtered.error ?? "invalid_settings", 400);
  }
  const settings: FilteredAccountSettings = filtered.settings;

  // A payload with no storable groups at all (e.g. the shared SPA's
  // personal-favourites save, which is backend bookkeeping) is a no-op, not
  // an error: answer with the current settings so callers that reset their
  // form from the response stay consistent.
  const keys = Object.keys(settings);
  if (keys.length > 0) {
    for (const key of keys) {
      await db
        .insert(accountSettings)
        .values({ accountId: session.accountId, key, value: settings[key]! })
        .onConflictDoUpdate({
          set: { updatedAt: new Date(), value: settings[key]! },
          target: [accountSettings.accountId, accountSettings.key],
        });
    }

    // Group names only — the values are API keys and must not reach the
    // audit log.
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: {
        accountId: session.accountId,
        providerSubject: session.providerSubject,
      },
      eventType: "account.settings_updated",
      metadata: { keys },
    });
  }

  return NextResponse.json(
    await storedAccountSettings(db, session.accountId),
  );
}
