import { and, count, eq, isNull } from "drizzle-orm";
import { accountApiTokens } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  apiTokenAccessValues,
  defaultApiTokenTtlDays,
  listApiTokens,
  maxApiTokenNameLength,
  maxApiTokensPerAccount,
  maxApiTokenTtlDays,
  mintApiToken,
  serializeApiToken,
  type ApiTokenAccess,
} from "../../../../src/lib/api-tokens";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import {
  recentApprovalMaxAgeSeconds,
  requireRecentAuth,
} from "../../../../src/lib/recent-auth";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// Personal API tokens (src/lib/api-tokens.ts). GET lists the live ones —
// never the secret, only its hint. POST mints one and returns the secret
// exactly once. Minting turns a browser session into a durable credential,
// which is the same promotion approving a device link makes, so it asks for
// the same recent proof of the credentials (2 h) — and it is never allowed
// from a token itself: a leaked token must not be able to breed new ones.

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:api-tokens", {
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
  return NextResponse.json({
    default_ttl_days: defaultApiTokenTtlDays,
    max_tokens: maxApiTokensPerAccount,
    max_ttl_days: maxApiTokenTtlDays,
    tokens: await listApiTokens(db, session.accountId),
  });
}

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(
    request,
    "account:api-tokens-create",
    { limit: 30, windowMs: 15 * 60 * 1000 },
  );
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  if (session.apiToken) {
    return jsonError("api_token_not_allowed", 403);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const stale = await requireRecentAuth(
    db,
    session.accountId,
    recentApprovalMaxAgeSeconds,
  );
  if (stale) {
    return stale;
  }

  const body = await readJsonObject(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > maxApiTokenNameLength) {
    return jsonError("invalid_name", 400);
  }
  const access = body.access === undefined ? "full" : body.access;
  if (!apiTokenAccessValues.includes(access as ApiTokenAccess)) {
    return jsonError("invalid_access", 400);
  }
  // Every token expires: omitted means the default, and an explicit `null`
  // ("never") is refused rather than honoured — a token minted forever
  // outlives the laptop it was pasted into and the reason it was made.
  const days =
    body.expires_in_days === undefined ? defaultApiTokenTtlDays : body.expires_in_days;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > maxApiTokenTtlDays
  ) {
    return jsonError("invalid_expiry", 400);
  }
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const [existing] = await db
    .select({ count: count() })
    .from(accountApiTokens)
    .where(
      and(
        eq(accountApiTokens.accountId, session.accountId),
        isNull(accountApiTokens.revokedAt),
      ),
    );
  if ((existing?.count ?? 0) >= maxApiTokensPerAccount) {
    return jsonError("token_quota_exceeded", 403, {
      max_tokens: maxApiTokensPerAccount,
    });
  }

  const minted = mintApiToken(access as ApiTokenAccess);
  const [row] = await db
    .insert(accountApiTokens)
    .values({
      access: access as ApiTokenAccess,
      accountId: session.accountId,
      expiresAt,
      name,
      tokenHash: minted.tokenHash,
      tokenHint: minted.hint,
    })
    .returning();
  if (!row) {
    return jsonError("token_create_failed", 500);
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "account.api_token_created",
    metadata: { access, expires_at: expiresAt.toISOString(), name },
    target: { apiTokenId: row.id },
  });

  return NextResponse.json(
    {
      api_token: serializeApiToken(row),
      status: "created",
      token: minted.token,
    },
    { status: 201 },
  );
}
