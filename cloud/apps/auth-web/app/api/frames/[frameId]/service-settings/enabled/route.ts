import { eq } from "drizzle-orm";
import { linkedClients } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { linkedClientScopes } from "../../../../../../src/lib/backend-auth";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import {
  enqueueServiceSettingsRefresh,
  frameForAccount,
  frameServiceSettingsScope,
} from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// The OWNER's per-frame switch for service-settings delivery
// (docs/cloud-frames.md, "Service settings"). Body: {"enabled": true|false}.
//
// It grants or revokes `settings:services` on the frame's linked client, which
// is what the device-authed pull route checks. Revocation actually REMOVES the
// scope from `provider_client_metadata.requestedScopes` rather than marking it
// somewhere: the device's own scope bookkeeping is additive (it unions the
// `ready` scope list into its local copy and never drops one), so a device
// will happily keep asking — the 403 from the pull route is the boundary that
// stops it, and it can only exist if the scope is genuinely gone from the row.
//
// The audit event records the FLAG and never a value: which keys the account
// holds, let alone what they are, has no business in an audit log.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:service-settings-scope", {
    limit: 60,
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
  const { frameId } = await params;
  // Owner-only: frameForAccount is the ownership check.
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }

  const body = await readJsonObject(request);
  if (typeof body.enabled !== "boolean") {
    return jsonError("invalid_enabled", 400);
  }
  const enabled = body.enabled;

  const [linkedClient] = await db
    .select()
    .from(linkedClients)
    .where(eq(linkedClients.id, frame.linkedClientId))
    .limit(1);
  if (!linkedClient) {
    return jsonError("invalid_frame", 404);
  }

  const current = linkedClientScopes(linkedClient);
  const scopes = enabled
    ? current.includes(frameServiceSettingsScope)
      ? current
      : [...current, frameServiceSettingsScope]
    : current.filter((scope) => scope !== frameServiceSettingsScope);

  if (scopes.length !== current.length) {
    const metadata =
      linkedClient.providerClientMetadata &&
      typeof linkedClient.providerClientMetadata === "object" &&
      !Array.isArray(linkedClient.providerClientMetadata)
        ? (linkedClient.providerClientMetadata as Record<string, unknown>)
        : {};
    await db
      .update(linkedClients)
      .set({
        providerClientMetadata: { ...metadata, requestedScopes: scopes },
        updatedAt: new Date(),
      })
      .where(eq(linkedClients.id, linkedClient.id));
  }

  // Tell the frame to come and get them. Only for an active frame: a pending
  // one has no confirmed owner yet and a revoked one's queue is expired on
  // sight. The nudge is advisory — a frame that misses it re-pulls at `ready`.
  let command:
    | Awaited<ReturnType<typeof enqueueServiceSettingsRefresh>>
    | undefined;
  if (enabled && frame.status === "active") {
    command = await enqueueServiceSettingsRefresh(db, frame.id);
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.service_settings_scope_changed",
    // The flag only. Never group names, never values.
    metadata: { enabled },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({
    command_id: command?.id ?? null,
    enabled,
    status: "updated",
  });
}
