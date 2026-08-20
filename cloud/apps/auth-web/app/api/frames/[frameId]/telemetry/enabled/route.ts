import { eq } from 'drizzle-orm'
import { linkedClients } from '@frameos-cloud/db'
import { NextRequest, NextResponse } from 'next/server'
import { recordAuditEvent } from '../../../../../../src/lib/audit'
import { linkedClientScopes } from '../../../../../../src/lib/backend-auth'
import { csrfResponse } from '../../../../../../src/lib/csrf'
import { jsonError, readJsonObject, requireDatabase } from '../../../../../../src/lib/device-flow'
import {
  enqueueFrameCommand,
  frameForAccount,
  frameTelemetryLogsScope,
  frameTelemetryMetricsScope,
} from '../../../../../../src/lib/frames'
import { rateLimitResponse } from '../../../../../../src/lib/rate-limit'
import { readSession } from '../../../../../../src/lib/session'

export const runtime = 'nodejs'

// The OWNER's per-frame switch for telemetry (logs + metrics) shipping. Body:
// {"enabled": true|false}. Sibling of service-settings/enabled, same shape.
//
// Why it exists: frames enrolled before 2026-08-03 (#288) hold links without
// `telemetry:logs` / `telemetry:metrics`, and enrollment deliberately never
// backfills scopes onto an existing link — adding a scope the owner did not
// approve is exactly the silent escalation the device flow refuses. Such a
// frame connects, deploys and renders normally but never ships a log line:
// the device gates its push loops on the scope list in the hub's `ready`
// message, and the hub answers any stray log_batch with insufficient_scope.
// The Logs panel stays empty and nothing says why. This route is the owner
// saying "yes, ship them" — an explicit grant, not a backfill.
//
// Scopes are captured once, at the WebSocket upgrade, and pinned on the
// session for its lifetime (frame-hub attachDeviceSocket). So a change here
// only takes effect at the device's NEXT connection, in either direction:
// enabling without a reconnect leaves the device's push loops off; disabling
// without one leaves the hub accepting batches until the socket drops. An
// active frame is therefore asked to restart its runtime (the same
// `restart_runtime` the canonical /restart route queues, same short TTL), so
// the switch does what it says within the minute instead of "eventually".
const restartTtlMs = 5 * 60 * 1000
const telemetryScopes = [frameTelemetryLogsScope, frameTelemetryMetricsScope]

export async function POST(request: NextRequest, { params }: { params: Promise<{ frameId: string }> }) {
  const csrf = csrfResponse(request)
  if (csrf) {
    return csrf
  }
  const limited = await rateLimitResponse(request, 'frames:telemetry-scope', {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  })
  if (limited) {
    return limited
  }
  const session = await readSession()
  if (!session?.accountId) {
    return jsonError('login_required', 401)
  }
  const { db, response } = requireDatabase()
  if (!db) {
    return response
  }
  const { frameId } = await params
  // Owner-only: frameForAccount is the ownership check.
  const frame = await frameForAccount(db, session.accountId, frameId)
  if (!frame) {
    return jsonError('invalid_frame', 404)
  }

  const body = await readJsonObject(request)
  if (typeof body.enabled !== 'boolean') {
    return jsonError('invalid_enabled', 400)
  }
  const enabled = body.enabled

  const [linkedClient] = await db
    .select()
    .from(linkedClients)
    .where(eq(linkedClients.id, frame.linkedClientId))
    .limit(1)
  if (!linkedClient) {
    return jsonError('invalid_frame', 404)
  }

  const current = linkedClientScopes(linkedClient)
  const scopes = enabled
    ? [...current, ...telemetryScopes.filter((scope) => !current.includes(scope))]
    : current.filter((scope) => !telemetryScopes.includes(scope))

  const changed = scopes.length !== current.length
  if (changed) {
    const metadata =
      linkedClient.providerClientMetadata &&
      typeof linkedClient.providerClientMetadata === 'object' &&
      !Array.isArray(linkedClient.providerClientMetadata)
        ? (linkedClient.providerClientMetadata as Record<string, unknown>)
        : {}
    await db
      .update(linkedClients)
      .set({
        providerClientMetadata: { ...metadata, requestedScopes: scopes },
        updatedAt: new Date(),
      })
      .where(eq(linkedClients.id, linkedClient.id))
  }

  // Only when something changed and only for an active frame: a pending one
  // has no confirmed owner yet, a revoked one's queue is expired on sight,
  // and a no-op toggle must not power-cycle anything.
  let command: Awaited<ReturnType<typeof enqueueFrameCommand>> | undefined
  if (changed && frame.status === 'active') {
    command = await enqueueFrameCommand(db, {
      createdByAccountId: session.accountId,
      frameId: frame.id,
      ttlMs: restartTtlMs,
      type: 'restart_runtime',
    })
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: 'frame.telemetry_scope_changed',
    metadata: { enabled },
    target: { commandId: command?.id, frameId: frame.id },
  })

  return NextResponse.json({
    command_id: command?.id ?? null,
    enabled,
    status: 'updated',
  })
}
