import { and, eq, sql } from "drizzle-orm";
import { frames } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "./audit";
import { csrfResponse } from "./csrf";
import { jsonError, readJsonObject, requireDatabase } from "./device-flow";
import { waitForFrameCommand } from "./frame-command-wait";
import {
  frameLanAccess,
  lanAccessAckPollMs,
  lanAccessAckWaitMs,
  lanAccessChallengeTtlMs,
  lanAccessChallengeVerb,
  lanAccessOutcomeResponse,
  lanAccessRefusal,
  lanAccessSetTtlMs,
  lanAccessSetVerb,
  parseLanAccessSetBody,
  type FrameCommandOutcome,
  type LanAccessSetPayload,
  type LanAccessVerb,
} from "./frame-lan-access";
import { frameIsAsleep } from "./frame-sleep";
import { enqueueFrameCommand, frameForAccount, supersedePendingCommands } from "./frames";
import { identityRateLimitResponse, rateLimitResponse } from "./rate-limit";
import { readSession } from "./session";

// POST /api/frames/{id}/lan_access/challenge and POST /api/frames/{id}/lan_access,
// which the shared SPA's local network access dialog calls (docs/lan-access.md;
// cloud frames only, the backend has no such routes). Each enqueues its verb
// (lan_access_challenge / lan_access_set, never the generic /command route:
// they are not in allowedFrameCommandTypes) and waits a bounded time for the
// device's ack. The answers are in lanAccessOutcomeResponse.
//
// The code the owner types is the one secret here. It rides the command's
// payload to the device and nowhere else: not in an audit row, not in a log
// line, not in the pending-command listing (pendingCommandView never echoes
// a payload), and the hub drops it from the row once the device answers.

// Every request is either a challenge (an e-ink refresh, an ESP32 kept awake)
// or one code guess, so both share a bucket per client...
const lanAccessRateLimit = { limit: 60, windowMs: 15 * 60 * 1000 };
// ...and challenges have their own per-account, per-frame ceiling: each new
// code is five more guesses, and nobody needs twenty codes in an hour.
const challengeRateLimit = { limit: 20, windowMs: 60 * 60 * 1000 };

type RouteParams = Promise<{ frameId: string }>;
type Database = NonNullable<ReturnType<typeof requireDatabase>["db"]>;

async function lanAccessRequestContext(request: NextRequest, params: RouteParams) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return { response: csrf };
  }
  const limited = await rateLimitResponse(request, "frames:lan-access", lanAccessRateLimit);
  if (limited) {
    return { response: limited };
  }
  const session = await readSession();
  if (!session?.accountId) {
    return { response: jsonError("login_required", 401) };
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return { response: response! };
  }
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return { response: jsonError("invalid_frame", 404) };
  }
  if (frame.status !== "active") {
    return { response: jsonError("frame_not_active", 409) };
  }
  // Firmware that does not report the switch does not know the verbs either:
  // refuse here instead of queueing a command it would answer unknown_verb
  // to, possibly hours from now on a sleeping frame.
  if (frameLanAccess(frame.hardware) === null) {
    const refusal = lanAccessRefusal("unsupported");
    return {
      response: NextResponse.json({ detail: refusal.detail, error: refusal.error }, { status: refusal.status }),
    };
  }
  return {
    db,
    frame,
    session: { accountId: session.accountId, providerSubject: session.providerSubject },
  };
}

type LanAccessContext = Exclude<Awaited<ReturnType<typeof lanAccessRequestContext>>, { response: Response }>;

async function sendLanAccessVerb(
  context: LanAccessContext,
  verb: LanAccessVerb,
  payload: Record<string, unknown>,
  ttlMs: number,
): Promise<FrameCommandOutcome> {
  const { db, frame, session } = context;
  // The newest request is the one the owner is looking at: an older
  // challenge would repaint the panel with a code nobody will type, and an
  // older set would spend an attempt with a code that no longer matters.
  await supersedePendingCommands(db, frame.id, verb);
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    payload,
    ttlMs,
    type: verb,
  });
  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: session,
    eventType: "frame.command_sent",
    // The verb and the switch position, never the code.
    metadata: {
      type: verb,
      ...(typeof payload.enabled === "boolean" ? { enabled: payload.enabled } : {}),
    },
    target: { commandId: command?.id, frameId: frame.id },
  });
  if (!command) {
    return { state: "missing" };
  }
  // A frame that is offline or announced a sleep answers on its next wake:
  // the command is queued for it, but nobody should wait for that now.
  if (!frame.connected || frameIsAsleep(frame)) {
    return { state: "waiting" };
  }
  return waitForFrameCommand(db, command.id, { pollMs: lanAccessAckPollMs, timeoutMs: lanAccessAckWaitMs });
}

// The device persisted the switch and will say so in its next `state`; the
// row's copy is updated now so a reload in between does not show the old
// value. One key, in place: a `state` landing at the same moment rewrites
// the whole report with the same answer, never a stale one.
async function mirrorLanAccess(db: Database, frameId: string, enabled: boolean) {
  await db
    .update(frames)
    .set({
      hardware: sql`jsonb_set(${frames.hardware}, '{lanAccess}', ${enabled ? sql`'true'::jsonb` : sql`'false'::jsonb`})`,
      updatedAt: new Date(),
    })
    .where(and(eq(frames.id, frameId), sql`jsonb_typeof(${frames.hardware}) = 'object'`));
}

function outcomeJson(verb: LanAccessVerb, outcome: FrameCommandOutcome, enabled?: boolean) {
  const { body, status } = lanAccessOutcomeResponse(verb, outcome, enabled);
  return NextResponse.json(body, { headers: { "cache-control": "no-store" }, status });
}

export async function handleLanAccessChallenge(request: NextRequest, params: RouteParams): Promise<Response> {
  const context = await lanAccessRequestContext(request, params);
  if ("response" in context) {
    return context.response;
  }
  const limited = await identityRateLimitResponse(
    `${context.session.accountId}:${context.frame.id}`,
    "frames:lan-access-challenge",
    challengeRateLimit,
  );
  if (limited) {
    return limited;
  }
  const outcome = await sendLanAccessVerb(context, lanAccessChallengeVerb, {}, lanAccessChallengeTtlMs);
  return outcomeJson(lanAccessChallengeVerb, outcome);
}

export async function handleLanAccessSet(request: NextRequest, params: RouteParams): Promise<Response> {
  const context = await lanAccessRequestContext(request, params);
  if ("response" in context) {
    return context.response;
  }
  const parsed = parseLanAccessSetBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json({ detail: parsed.detail, error: parsed.error }, { status: parsed.status });
  }
  const payload: LanAccessSetPayload = parsed.payload;
  const outcome = await sendLanAccessVerb(context, lanAccessSetVerb, { ...payload }, lanAccessSetTtlMs);
  if (outcome.state === "acked") {
    await mirrorLanAccess(context.db, context.frame.id, payload.enabled);
    await recordAuditEvent(context.db, {
      accountId: context.session.accountId,
      actor: context.session,
      eventType: "frame.lan_access_changed",
      metadata: { enabled: payload.enabled },
      target: { frameId: context.frame.id },
    });
  }
  return outcomeJson(lanAccessSetVerb, outcome, payload.enabled);
}
