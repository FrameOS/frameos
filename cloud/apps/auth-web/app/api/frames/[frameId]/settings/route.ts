import { eq, sql } from 'drizzle-orm'
import { frames } from '@frameos-cloud/db'
import { recordAuditEvent } from '../../../../../src/lib/audit'
import { NextRequest, NextResponse } from 'next/server'
import { csrfResponse } from '../../../../../src/lib/csrf'
import { jsonError, readJsonObject, requireDatabase } from '../../../../../src/lib/device-flow'
import {
  enqueueFrameSettingsPush,
  frameForAccount,
  frameHardwareIsEsp32,
  frameSettingsRefusal,
  mergeFrameSettings,
  readFrameSettings,
  validateFrameSettings,
} from '../../../../../src/lib/frames'
import { rateLimitResponse } from '../../../../../src/lib/rate-limit'
import {
  accountLimits,
  cloudRenderedMinIntervalSeconds,
  countCloudRenderedFramesForAccount,
  frameIsCloudRendered,
} from '../../../../../src/lib/usage'
import { readSession } from '../../../../../src/lib/session'

export const runtime = 'nodejs'

class CloudRenderedQuotaError extends Error {
  constructor(readonly maxCloudRenderedFrames: number) {
    super('cloud_rendered_frame_quota_exceeded')
  }
}

// The interval a frame runs at now: the last one pushed, else what it reports.
function currentInterval(frame: { hardware: unknown; settings: unknown }): number | undefined {
  const stored = readFrameSettings(frame.settings).interval
  if (typeof stored === 'number') {
    return stored
  }
  const reported =
    frame.hardware && typeof frame.hardware === 'object' && !Array.isArray(frame.hardware)
      ? (frame.hardware as Record<string, unknown>).interval
      : undefined
  return typeof reported === 'number' && Number.isFinite(reported) ? reported : undefined
}

// Declarative settings push. The allowlist is enforced here AND on the
// device — the control plane refusing early is UX; the device refusing is
// the security boundary.
export async function POST(request: NextRequest, { params }: { params: Promise<{ frameId: string }> }) {
  const csrf = csrfResponse(request)
  if (csrf) {
    return csrf
  }
  const limited = await rateLimitResponse(request, 'frames:settings', {
    limit: 120,
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
  const frame = await frameForAccount(db, session.accountId, frameId)
  if (!frame) {
    return jsonError('invalid_frame', 404)
  }
  if (frame.status !== 'active') {
    return jsonError('frame_not_active', 409)
  }

  const body = await readJsonObject(request)
  const validated = validateFrameSettings(body.settings)
  if (validated.error || !validated.settings) {
    return jsonError(validated.error ?? 'invalid_settings', 400)
  }
  const settings = validated.settings

  // The frame's NAME is provider-side data (frames.name, what frameSummary
  // returns) — the device never has to accept it. Everything else must be a
  // key the device's profile takes, at a value its rules allow, on firmware
  // that knows the key: the contract answers all three (frameSettingsRefusal),
  // and a device refuses the WHOLE push on the first key it cannot take, so
  // refuse here, up front, with a code the SPA turns into "update the frame
  // first" — nothing is ever half-applied.
  const isEsp32 = frameHardwareIsEsp32(frame)
  const refusal = frameSettingsRefusal(frame, settings)
  if (refusal) {
    return jsonError(
      refusal.error,
      400,
      refusal.minFrameosVersion ? { min_frameos_version: refusal.minFrameosVersion } : undefined,
    )
  }

  // Mirror what was pushed so the Settings panel hydrates on the next load
  // (and so a push toward an offline device is not lost from the UI). The
  // name lands in frames.name, everything else in frames.settings, merged
  // onto what was there so a one-key push does not blank the rest.
  // §0.2 (cloud/docs/accounting-todo.md): a frame the cloud renders for is
  // entitled as N frames AND a refresh floor, because renders per day is the
  // cost. The plan sells "N frames"; this is where the other half bites.
  // A board with its own runtime set to render on the server
  // (`render_mode: "remote"`, docs/server-rendering.md) becomes one of these
  // frames with this push: it takes one of the plan's cloud-rendered frames,
  // and its interval may not be under the floor from then on.
  const mergedSettings = mergeFrameSettings(frame.settings, settings)
  const renderedBefore = frameIsCloudRendered(frame)
  const renderedAfter = frameIsCloudRendered({ hardware: frame.hardware, settings: mergedSettings ?? frame.settings })
  const turningOn = renderedAfter && !renderedBefore
  const interval = typeof settings.interval === 'number' ? settings.interval : turningOn ? currentInterval(frame) : undefined
  if (renderedAfter && interval !== undefined && interval < cloudRenderedMinIntervalSeconds) {
    return jsonError('interval_below_plan_floor', 400, { min_interval: cloudRenderedMinIntervalSeconds })
  }

  const writeSettings = async (tx: Pick<typeof db, 'update'>) => {
    if (typeof settings.name === 'string' || mergedSettings) {
      await tx
        .update(frames)
        .set({
          ...(typeof settings.name === 'string' ? { name: settings.name } : {}),
          ...(mergedSettings ? { settings: mergedSettings } : {}),
          updatedAt: new Date(),
        })
        .where(eq(frames.id, frame.id))
    }
  }
  if (turningOn) {
    // Counted and written behind the same lock virtual frames are created
    // under, so two pushes (or a push and a new virtual frame) cannot both
    // take the plan's last place.
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`virtual-frames:${frame.accountId}`}, 0))`)
        const limits = await accountLimits(tx, frame.accountId)
        if ((await countCloudRenderedFramesForAccount(tx, frame.accountId)) >= limits.cloudRenderedFrames) {
          throw new CloudRenderedQuotaError(limits.cloudRenderedFrames)
        }
        await writeSettings(tx)
      })
    } catch (error) {
      if (error instanceof CloudRenderedQuotaError) {
        return jsonError('cloud_rendered_frame_quota_exceeded', 403, {
          max_cloud_rendered_frames: error.maxCloudRenderedFrames,
        })
      }
      throw error
    }
  } else {
    await writeSettings(db)
  }

  // Devices get the push (name included) so their local config stays in
  // sync with what the cloud now shows. For ESP32 a name-only payload skips
  // the command: the display name is provider data, and older firmware
  // without the set_settings verb would refuse the push for nothing.
  const needsDevicePush = !isEsp32 || Object.keys(settings).some((key) => key !== 'name')
  let command: Awaited<ReturnType<typeof enqueueFrameSettingsPush>> | undefined
  if (needsDevicePush) {
    // Builds the device payload (an ESP32 gets its tzdata slice next to the
    // zone name) and supersedes any undelivered set_settings first.
    command = await enqueueFrameSettingsPush(db, frame, settings, { createdByAccountId: session.accountId })
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: 'frame.settings_pushed',
    metadata: { keys: Object.keys(settings) },
    target: { commandId: command?.id, frameId: frame.id },
  })
  // A rename rides the settings push, but "settings updated: name" does not
  // tell you what the frame used to be called. Record it on its own, with
  // both names, so the frame's activity feed shows old → new.
  if (typeof settings.name === 'string' && settings.name !== frame.name) {
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: {
        accountId: session.accountId,
        providerSubject: session.providerSubject,
      },
      eventType: 'frame.renamed',
      metadata: { from: frame.name, to: settings.name },
      target: { commandId: command?.id, frameId: frame.id },
    })
  }

  return NextResponse.json({
    command_id: command?.id ?? null,
    status: command ? 'queued' : 'applied',
  })
}
