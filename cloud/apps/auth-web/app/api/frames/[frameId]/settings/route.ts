import { eq } from 'drizzle-orm'
import { frames } from '@frameos-cloud/db'
import { recordAuditEvent } from '../../../../../src/lib/audit'
import { NextRequest, NextResponse } from 'next/server'
import { csrfResponse } from '../../../../../src/lib/csrf'
import { fetchTzSlice } from '../../../../../src/lib/tz-slice'
import { jsonError, readJsonObject, requireDatabase } from '../../../../../src/lib/device-flow'
import {
  enqueueFrameCommand,
  esp32ExtendedFrameSettingKeys,
  esp32ExtendedFrameSettingsMinVersion,
  esp32MaxGpioButtons,
  esp32OnlySettableKeys,
  esp32SettableKeys,
  esp32TimeZoneFrameSettingKeys,
  esp32TimeZoneFrameSettingsMinVersion,
  extendedFrameSettingKeys,
  extendedFrameSettingsMinVersion,
  frameForAccount,
  frameHardwareIsEsp32,
  frameSupportsExtendedSettings,
  frameSupportsHardwareSettings,
  frameSupportsSettingsFrom,
  hardwareFrameSettingKeys,
  hardwareFrameSettingsMinVersion,
  mergeFrameSettings,
  supersedePendingCommands,
  validateFrameSettings,
} from '../../../../../src/lib/frames'
import { rateLimitResponse } from '../../../../../src/lib/rate-limit'
import { readSession } from '../../../../../src/lib/session'

export const runtime = 'nodejs'

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
  // returns) — the device never has to accept it. The ESP32 firmware's
  // set_settings applies only `interval`, `name` and `rotate` (its
  // declarative subset; anything else it refuses whole-verb with
  // setting_not_allowed), so a payload carrying other keys is refused up
  // front and nothing is half-applied.
  const isEsp32 = frameHardwareIsEsp32(frame)
  if (isEsp32 && Object.keys(settings).some((key) => !esp32SettableKeys.has(key))) {
    return jsonError('settings_not_supported_by_device', 400)
  }
  // ESP32 firmware before 2026.8.31 refuses the whole verb on debug /
  // max_http_response_bytes / gpio_buttons; and its button table holds
  // fewer entries than the Pi's.
  if (
    isEsp32 &&
    !frameSupportsSettingsFrom(esp32ExtendedFrameSettingsMinVersion, frame.frameosVersion) &&
    Object.keys(settings).some((key) => esp32ExtendedFrameSettingKeys.has(key))
  ) {
    return jsonError('settings_need_newer_firmware', 400, {
      min_frameos_version: esp32ExtendedFrameSettingsMinVersion,
    })
  }
  // Same shape for the 2026.8.34 time zone key.
  if (
    isEsp32 &&
    !frameSupportsSettingsFrom(esp32TimeZoneFrameSettingsMinVersion, frame.frameosVersion) &&
    Object.keys(settings).some((key) => esp32TimeZoneFrameSettingKeys.has(key))
  ) {
    return jsonError('settings_need_newer_firmware', 400, {
      min_frameos_version: esp32TimeZoneFrameSettingsMinVersion,
    })
  }
  if (isEsp32 && Array.isArray(settings.gpio_buttons) && settings.gpio_buttons.length > esp32MaxGpioButtons) {
    return jsonError('invalid_settings', 400)
  }
  // The inverse holds too: the power keys exist only in the ESP32 firmware's
  // profile — the Pi runtime's CLOUD_SETTINGS_ALLOWLIST refuses the whole
  // verb on any of them, so refuse up front instead of half-applying.
  if (!isEsp32 && Object.keys(settings).some((key) => esp32OnlySettableKeys.has(key))) {
    return jsonError('settings_not_supported_by_device', 400)
  }
  // The extended batch needs firmware that knows the keys. The frame reports
  // its version on every hello; a Pi frame still on older firmware refuses
  // the WHOLE push on the first key it does not recognise, taking `name`
  // and `interval` down with it — so refuse here, with a code the SPA turns
  // into "update the frame first". A frame that never reported a version
  // (never connected) is refused too: see frameSupportsExtendedSettings.
  if (
    !isEsp32 &&
    !frameSupportsExtendedSettings(frame.frameosVersion) &&
    Object.keys(settings).some((key) => extendedFrameSettingKeys.has(key))
  ) {
    return jsonError('settings_need_newer_firmware', 400, {
      min_frameos_version: extendedFrameSettingsMinVersion,
    })
  }
  // The hardware batch (palette, partial refresh, GPIO buttons) has its own,
  // later floor. Same failure mode below it: the whole push refused on the
  // device, so refuse it here with the version the SPA should ask for.
  if (
    !isEsp32 &&
    !frameSupportsHardwareSettings(frame.frameosVersion) &&
    Object.keys(settings).some((key) => hardwareFrameSettingKeys.has(key))
  ) {
    return jsonError('settings_need_newer_firmware', 400, {
      min_frameos_version: hardwareFrameSettingsMinVersion,
    })
  }

  // Mirror what was pushed so the Settings panel hydrates on the next load
  // (and so a push toward an offline device is not lost from the UI). The
  // name lands in frames.name, everything else in frames.settings, merged
  // onto what was there so a one-key push does not blank the rest.
  const mergedSettings = mergeFrameSettings(frame.settings, settings)
  if (typeof settings.name === 'string' || mergedSettings) {
    await db
      .update(frames)
      .set({
        ...(typeof settings.name === 'string' ? { name: settings.name } : {}),
        ...(mergedSettings ? { settings: mergedSettings } : {}),
        updatedAt: new Date(),
      })
      .where(eq(frames.id, frame.id))
  }

  // Devices get the push (name included) so their local config stays in
  // sync with what the cloud now shows. For ESP32 a name-only payload skips
  // the command: the display name is provider data, and older firmware
  // without the set_settings verb would refuse the push for nothing.
  const needsDevicePush = !isEsp32 || Object.keys(settings).some((key) => key !== 'name')
  let command: Awaited<ReturnType<typeof enqueueFrameCommand>> | undefined
  if (needsDevicePush) {
    // An ESP32 has no tz database: the zone's tzdata slice rides with the
    // name (fos_tz.h). Command payload only — never stored in frames.settings.
    let devicePayload: Record<string, unknown> = settings
    if (isEsp32 && typeof settings.timezone === 'string' && settings.timezone.trim()) {
      const slice = await fetchTzSlice(settings.timezone)
      if (slice) devicePayload = { ...settings, timezone_data: slice }
    }
    await supersedePendingCommands(db, frame.id, 'set_settings')
    command = await enqueueFrameCommand(db, {
      createdByAccountId: session.accountId,
      frameId: frame.id,
      payload: { settings: devicePayload },
      type: 'set_settings',
    })
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
