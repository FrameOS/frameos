import type { ESPLoader, Transport as EspTransport } from 'esptool-js'

import {
  embeddedUsbLogStreamSessionPort,
  prepareSerialPortReconnect,
  resolveLiveSerialPort,
  stopEmbeddedUsbLogStream,
  usbProvisionWifi,
  usbRestart,
  usbSet,
  waitForEmbeddedUsbApiIdle,
  type EmbeddedUsbConfigKey,
} from '../../models/embeddedUsbLogsModel'
import type { FrameId } from '../../types'
import {
  ESP32_PARTITION_TABLE_OFFSET,
  ESP32_PARTITION_TABLE_SIZE,
  detectFlashSize,
  deviceLayoutMatchesPlan,
  firmwareUpdateWritePlan,
  firstBootConsoleWaitMs,
  layoutMatchedPlatform,
  layoutPlatformForPartitions,
  parseEsp32PartitionTable,
  partitionTableFlashMb,
  releaseChipMismatch,
  type Esp32Partition,
  type FirmwareUpdateWritePlan,
} from './embeddedFlashImage'
import {
  POST_FLASH_BOOT_WAIT_MS,
  appendBrowserFlashLog,
  createUsbLogTerminal,
  loadEsptoolForFlash,
  recordTransportTrace,
  sleep,
  uploadScenesOverUsbAfterFlash,
  waitForUsbApiReadyAfterFlash,
  watchdogResetAfterFlash,
  type FlashLogTerminal,
  type FlashPhase,
  type FlashTraceRecorder,
} from './embeddedFlashShared'
import { pushScenesOverUsb, pushedScenesMessage } from './embeddedUsbScenePush'
import type { FirmwareSource, ReleaseImage } from './releaseFirmware'

// The two browser flashes of an ESP32, with no frame, plane or page in them:
// a blank board (the release image from 0x0, then this frame's settings over
// the same cable: flashAndSetUpBoard) and an enrolled one (the release
// written around its settings partition: updateBoardKeepingSettings). The
// backend's buttons (EmbeddedReleaseFlasher, EmbeddedUsbFirmwareUpdate) and
// flash.frameos.net (cloud-frontend/src/flasher, cloud/docs/flasher.md) run
// these; what each adds is where the setup comes from and what happens
// around it (a backend records the board's flash size, a bridge reports
// back to the page that opened it).
//
// Every image is checked against the release signature by its FirmwareSource
// before a byte is written (releaseFirmware.ts).

const PROVISION_COMMAND_TIMEOUT_MS = 15000

/** Where a flash reports: the status line, the phase and the progress bar. */
export interface FlashReporter {
  /** What the USB session and its log lines are filed under: the frame, or
   * flash.frameos.net's own board. */
  frameId: FrameId
  setPhase: (phase: FlashPhase) => void
  setProgress: (progress: number | null) => void
  /** The status line; flashes also put most of them in the USB log. */
  setMessage: (message: string | null) => void
  /** The port is the flash's: a frame's page opens its logs behind it. */
  onPortTaken?: () => void
}

function say(reporter: FlashReporter, message: string): void {
  reporter.setMessage(message)
  appendBrowserFlashLog(reporter.frameId, message)
}

export interface EmbeddedProvisioningSetting {
  key: EmbeddedUsbConfigKey
  value: string
  secret: boolean
}

export interface EmbeddedProvisioningPlan {
  supported: boolean
  platform: string
  releasePlatform: string | null
  releaseFlashSize: string | null
  /** "bin" = esptool-flash the merged image, "uf2" = copy it onto a Pico's
   * BOOTSEL drive; null when nothing is published for the platform. Absent
   * on a backend that predates the field. */
  releaseFormat?: 'bin' | 'uf2' | null
  blockers: string[]
  warnings: string[]
  settings: EmbeddedProvisioningSetting[]
  wifi: { ssid: string; password: string } | null
}

/** What the console is told: the settings in order, then the Wi-Fi. */
export type ProvisioningCommands = Pick<EmbeddedProvisioningPlan, 'settings' | 'wifi'>

// Console keys that arrived with the release-image provisioning work
// (2026-09-03). A board still on older release firmware answers "unknown key"
// for them, and would otherwise stop the replay at the first one. They are a
// warning instead: every one of them also rides the backend's settings pull
// (hostname as `name`; the admin login, TLS and the HTTP cap on firmware that
// knows them), so the frame ends up correct once the board is on a current
// release. Anything else refused is a real failure.
const OPTIONAL_ON_OLDER_FIRMWARE: ReadonlySet<EmbeddedUsbConfigKey> = new Set<EmbeddedUsbConfigKey>([
  'hostname',
  'max_http_response_bytes',
  'admin_user',
  'admin_pass',
  'admin_auth',
  'tls_enable',
  'tls_port',
  // 2026.10.12: the button beep's buzzer and pitch. Both ride the settings
  // pull (`buzzerPin`, `buzzerToneHz`), and a current release takes the
  // E-series pin from the stored preset anyway.
  'buzzer_pin',
  'buzzer_tone_hz',
  // 2026.11.6: rides the settings pull too.
  'touch_beep',
  // 2026.11.15: the sounds of a tap and a press, on the settings pull too.
  'click_sounds',
  // 2026.11.7: the chip's clock, on the settings pull too (`cpuMode`).
  'cpu_mode',
  // 2026.10.20: the PDM microphone's pins (docs/voice-chat.md), one console
  // spec; they ride the settings pull too, and the reTerminal presets carry
  // their own.
  'mic_pins',
  // 2026.10.20: the status LED that follows the buzzer (fos_led.c). Both
  // ride the settings pull (`ledPin`, `ledType`), and the reTerminal presets
  // carry their own.
  'led_pin',
  'led_type',
  // 2026.11.16: the frame's own layout choice, sent by the browser flasher
  // alone. Before it every scene still wears the layout it names; only the
  // home (the scene switcher) and a scene installed later go without.
  'layout',
])

export interface ProvisionOverUsbResult {
  /** Keys the board refused because its firmware predates them. */
  skipped: EmbeddedUsbConfigKey[]
}

/**
 * Replay the plan over the board's USB API, in the order the backend gave it:
 * `set hardware` applies a whole board bundle (panel, EPD wiring, buttons, TF
 * socket), so everything this frame overrides on top of it has to come after.
 *
 * Wi-Fi goes last and reboots the board, because that is the point at which it
 * is finished — a board that reconnects half-provisioned would call home as
 * something that is not quite this frame. (Not here: the callers send it.)
 */
export async function provisionOverUsb(
  frameId: FrameId,
  plan: ProvisioningCommands,
  // The flasher holds the port it just flashed through; the USB setup card
  // has none and lets each command open the board's USB session itself.
  port: SerialPort | null,
  onStatus: (message: string) => void
): Promise<ProvisionOverUsbResult> {
  const total = plan.settings.length
  const skipped: EmbeddedUsbConfigKey[] = []
  for (const [index, setting] of plan.settings.entries()) {
    onStatus(
      `Provisioning the board (${index + 1}/${total}): ${setting.key}${setting.secret ? '' : ` = ${setting.value}`}`
    )
    try {
      await usbSet(frameId, setting.key, setting.value, {
        ...(port ? { port, keepOpen: true } : {}),
        timeoutMs: PROVISION_COMMAND_TIMEOUT_MS,
      })
    } catch (error) {
      if (!OPTIONAL_ON_OLDER_FIRMWARE.has(setting.key)) {
        throw error
      }
      skipped.push(setting.key)
      onStatus(`The board's firmware does not know ${setting.key} yet; it takes effect after a firmware update.`)
    }
  }
  return { skipped }
}

export function skippedSettingsNotice(skipped: EmbeddedUsbConfigKey[]): string | null {
  if (skipped.length === 0) {
    return null
  }
  return (
    `This board's firmware predates ${skipped.join(', ')}; those settings apply once it runs a current ` +
    'FrameOS release (Update over the air, or Update over USB).'
  )
}

/**
 * The port to flash through: the frame's open USB log stream's, or the one
 * the person picks. Call it before any other await of a click handler, or the
 * browser refuses the port prompt. Null when nothing was picked.
 */
export async function takeFlashPort(frameId: FrameId): Promise<SerialPort | null> {
  const activeLogPort = embeddedUsbLogStreamSessionPort(frameId)
  let port = activeLogPort ? await stopEmbeddedUsbLogStream(frameId) : await navigator.serial.requestPort()
  if (!port) {
    return null
  }
  await prepareSerialPortReconnect(port)
  // A USB API command still in flight (a `status` probe, a `restart`)
  // holds the port and resumes the log stream on it when it ends; opening
  // it underneath fails with "The port is already open". Wait it out,
  // then take the port back from the stream it may have restarted.
  await waitForEmbeddedUsbApiIdle(frameId)
  if (embeddedUsbLogStreamSessionPort(frameId)) {
    port = (await stopEmbeddedUsbLogStream(frameId)) ?? port
  }
  return port
}

function isPortSelectionCanceled(detail: string): boolean {
  return /No port selected|NotFoundError/i.test(detail)
}

function serialFailureMessage(detail: string): string {
  return /Failed to open serial port/i.test(detail)
    ? 'Could not open the serial port. Close other serial monitors and try again.'
    : detail
}

/** Reset into the new firmware: the RTC watchdog where the chip has one,
 * else the DTR/RTS dance a USB-UART bridge answers. */
async function resetAfterFlash(loader: ESPLoader, transport: EspTransport): Promise<void> {
  if (await watchdogResetAfterFlash(loader)) {
    return
  }
  try {
    await transport.setDTR(false)
    await transport.setRTS(true)
    await sleep(100)
    await transport.setRTS(false)
    await transport.setDTR(false)
  } catch (error) {
    // The port drops if the chip already reset mid-command; the post-flash
    // wait re-acquires it.
  }
}

interface EspSession {
  loader: ESPLoader
  transport: EspTransport
  chip: string
  terminal: FlashLogTerminal
  trace: FlashTraceRecorder
}

async function connectEsp(reporter: FlashReporter, port: SerialPort): Promise<EspSession> {
  // Loaded on demand: esptool-js adds ~380KB we only need when flashing.
  const { ESPLoader, Transport } = await loadEsptoolForFlash()
  const transport = new Transport(port, false)
  const trace = recordTransportTrace(reporter.frameId, transport)
  const terminal = createUsbLogTerminal(reporter.frameId)
  reporter.setPhase('connecting')
  say(reporter, 'Connecting to the board')
  const loader = new ESPLoader({ transport, baudrate: 460800, enableTracing: true, terminal })
  const chip = await loader.main()
  return { loader, transport, chip, terminal, trace }
}

export interface BoardSetup {
  firmware: FirmwareSource
  /** The generic image of the chip this frame is set up for
   * ('esp32-s3-generic'): what the board's flash size picks a layout of. */
  chipPlatform: string
  /** The image to write when the board's flash size cannot be read: the
   * frame's configured layout. */
  configuredPlatform: string
  configuredFlashSize?: string | null
  plan: ProvisioningCommands
  /** Sent before the Wi-Fi reboot, read once the board answers; none, and
   * the frame gets them once it connects (a backend's) or has none yet. */
  scenes: () => Promise<unknown[]>
  /** The board's flash size differs from the frame's: a backend records it. */
  onFlashSizeDetected?: (flashSize: string, log: (message: string) => void) => Promise<void>
  /** The scenes went over USB: a backend marks the deploy done. */
  onScenesUploaded?: () => Promise<void>
}

export type BoardSetupOutcome =
  | { status: 'cancelled' }
  /** Nothing was written; the message says why. */
  | { status: 'failed' }
  /** The firmware is on the board, the setup after it did not finish. */
  | { status: 'written'; port: SerialPort; error: string }
  | {
      status: 'done'
      port: SerialPort
      image: ReleaseImage
      platform: string
      detectedFlashSize: string | null
      skipped: EmbeddedUsbConfigKey[]
      scenesUploaded: boolean
    }

/**
 * Flash a BLANK board from the published release and provision it over the
 * same cable. Every panel driver is compiled into every release image, and
 * each value a frame needs has a `set` key on the device's USB console, so
 * the stock generic image for the board's chip and flash layout plus this
 * frame's command list IS this frame.
 *
 * Call it from a click handler before any other await (the port prompt).
 */
export async function flashAndSetUpBoard(reporter: FlashReporter, setup: BoardSetup): Promise<BoardSetupOutcome> {
  let port: SerialPort | null = null
  let session: EspSession | null = null
  let image: ReleaseImage | null = null
  let platform = setup.configuredPlatform
  let detectedFlashSize: string | null = null
  let firstBootWaitMs: number | undefined
  let flashSizeDiffersFromFrame = false

  reporter.setPhase('connecting')
  reporter.setProgress(null)
  say(reporter, 'Selecting USB port')
  try {
    port = await takeFlashPort(reporter.frameId)
    if (!port) {
      reporter.setPhase('idle')
      reporter.setMessage(null)
      return { status: 'cancelled' }
    }
    reporter.onPortTaken?.()
    reporter.setPhase('preparing')
    const listing = await setup.firmware.listing()
    session = await connectEsp(reporter, port)

    // The image is picked by the chip in front of us, not by the frame's
    // configured flash size: a merged image carries its partition table and
    // a flash-size header, and one built for a bigger chip boot-loops on a
    // smaller one ("Detected size(4096k) smaller than the size in the binary
    // image header(8192k)" — a 4 MB C3 dev board on a frame left at the
    // 8 MB default, 2026-09-05). The frame's own answer is the fallback when
    // the size cannot be read, the same order the cloud flasher uses.
    reporter.setPhase('preparing')
    detectedFlashSize = await detectFlashSize(session.loader)
    platform = detectedFlashSize
      ? layoutMatchedPlatform(setup.chipPlatform, detectedFlashSize, listing.assets)
      : setup.configuredPlatform
    // The image is for the frame's configured chip; a board with a different
    // one flashes "fine" and then boot-loops in the ROM for good.
    const chipMismatch = releaseChipMismatch(session.loader.chip?.CHIP_NAME, platform)
    if (chipMismatch) {
      throw new Error(chipMismatch)
    }
    if (!detectedFlashSize) {
      say(reporter, `Could not read the board's flash size; using the ${platform} image this frame is configured for.`)
    } else if (platform === setup.configuredPlatform) {
      say(reporter, `Flash size ${detectedFlashSize}: using the ${platform} image.`)
    } else {
      flashSizeDiffersFromFrame = true
      say(
        reporter,
        `Flash size ${detectedFlashSize}: this frame is set up for a ${setup.configuredFlashSize ?? 'different'} chip, ` +
          `so using the ${platform} image built for the board instead of ${setup.configuredPlatform}.`
      )
    }
    image = await setup.firmware.image(platform, listing, (message) => say(reporter, message))
    firstBootWaitMs = firstBootConsoleWaitMs(image.bytes)

    reporter.setPhase('flashing')
    say(reporter, `Flashing ${image.name} to ${session.chip}`)
    await session.loader.writeFlash({
      // The merged provisioning image is the whole flash from 0x0
      // (bootloader, partition table, blank otadata, app), so it goes down
      // as one write. Nothing is spared: this board is not yet a frame, and
      // its settings are about to be provisioned from scratch anyway.
      fileArray: [{ address: 0x0, data: image.bytes }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex, written, total) => {
        reporter.setProgress(total > 0 ? Math.min(100, Math.round((written / total) * 100)) : null)
      },
    })
  } catch (error) {
    reporter.setProgress(null)
    const detail = error instanceof Error ? error.message : String(error)
    session?.terminal.flush()
    await session?.transport.disconnect().catch(() => undefined)
    if (isPortSelectionCanceled(detail)) {
      reporter.setPhase('idle')
      reporter.setMessage(null)
      return { status: 'cancelled' }
    }
    reporter.setPhase('error')
    const displayMessage = serialFailureMessage(detail)
    reporter.setMessage(displayMessage)
    appendBrowserFlashLog(reporter.frameId, `Flash failed: ${displayMessage}`)
    session?.trace.dumpAfterFailure()
    return { status: 'failed' }
  }

  // Written: from here on the board runs FrameOS whatever else happens.
  session.trace.expectReboot()
  await resetAfterFlash(session.loader, session.transport)
  reporter.setPhase('preparing')
  reporter.setProgress(null)
  say(reporter, 'Firmware written. Waiting for the board to reboot.')
  session.terminal.flush()
  await session.transport.disconnect().catch(() => undefined)

  try {
    if (flashSizeDiffersFromFrame && detectedFlashSize && setup.onFlashSizeDetected) {
      // The board now runs the layout for its real chip; the frame record is
      // what the OTA offer and the next provisioning plan read, so it follows
      // the chip. Best effort: a failure here leaves a note, not a
      // half-provisioned board.
      await setup.onFlashSizeDetected(detectedFlashSize, (message) => say(reporter, message))
    }
    await sleep(POST_FLASH_BOOT_WAIT_MS)
    port = await waitForUsbApiReadyAfterFlash(
      reporter.frameId,
      port,
      (message) => say(reporter, message),
      undefined,
      firstBootWaitMs
    )
    const { skipped } = await provisionOverUsb(reporter.frameId, setup.plan, port, reporter.setMessage)
    appendBrowserFlashLog(
      reporter.frameId,
      `Provisioned ${setup.plan.settings.length - skipped.length} of ${setup.plan.settings.length} setting(s) over USB.`
    )
    const notice = skippedSettingsNotice(skipped)
    if (notice) {
      appendBrowserFlashLog(reporter.frameId, notice)
    }

    // Scenes before the Wi-Fi reboot: the board is up and answering, and
    // pushing them now saves a second boot wait.
    const scenesUploaded = await uploadScenesOverUsbAfterFlash(
      reporter.frameId,
      await setup.scenes(),
      port,
      (message) => say(reporter, message)
    )
    if (scenesUploaded && setup.onScenesUploaded) {
      await setup.onScenesUploaded()
    }

    if (setup.plan.wifi) {
      say(reporter, `Joining ${setup.plan.wifi.ssid} and restarting`)
      await usbProvisionWifi(reporter.frameId, setup.plan.wifi.ssid, setup.plan.wifi.password, {
        port,
        keepOpen: true,
      })
    } else {
      say(reporter, 'Restarting the board')
      await usbRestart(reporter.frameId, { port, keepOpen: true })
    }
    // That reboot re-enumerates the USB device, so the port the caller hands
    // its log stream has to be the replacement, not the one that went away.
    port = (await resolveLiveSerialPort(port)) ?? port

    reporter.setPhase('done')
    say(
      reporter,
      setup.plan.wifi
        ? `Flashed the published firmware and provisioned this frame. The board is joining ${setup.plan.wifi.ssid}.`
        : 'Flashed the published firmware and provisioned this frame. Add a Wi-Fi network, or join one from the board’s setup portal.'
    )
    return { status: 'done', port, image, platform, detectedFlashSize, skipped, scenesUploaded }
  } catch (error) {
    reporter.setPhase('error')
    const detail = error instanceof Error ? error.message : String(error)
    say(
      reporter,
      `Firmware written, but setup did not finish: ${detail} The board runs FrameOS now. ` +
        'Use “Read the board again” to finish setting it up, or flash again.'
    )
    return { status: 'written', port, error: detail }
  }
}

/**
 * The partition table on the board, or null when it cannot be read — some
 * chips/stubs decline flash reads, and a blank board has none. It decides two
 * things: which release image to fetch (the one built for this layout, see
 * layoutPlatformForPartitions) and whether the NVS-sparing plan is safe to
 * write (assertDeviceLayoutMatches).
 */
async function readDevicePartitionTable(
  loader: { readFlash?: (address: number, size: number) => Promise<Uint8Array> },
  log: (message: string) => void
): Promise<Esp32Partition[] | null> {
  if (typeof loader.readFlash !== 'function') {
    return null
  }
  let table: Uint8Array
  try {
    table = await loader.readFlash(ESP32_PARTITION_TABLE_OFFSET, ESP32_PARTITION_TABLE_SIZE)
  } catch (error) {
    log("Could not read the board's partition table; trusting the image's own layout.")
    return null
  }
  const partitions = parseEsp32PartitionTable(table)
  if (partitions.length === 0) {
    log("The board has no readable partition table yet; trusting the image's own layout.")
    return null
  }
  return partitions
}

/**
 * Refuse the update when the board is partitioned differently from the image:
 * the hole this plan leaves would then land somewhere other than the board's
 * NVS, wiping the credentials it exists to protect. An unreadable table is not
 * treated as a mismatch, but then the guarantee rests on the image alone.
 */
function assertDeviceLayoutMatches(partitions: Esp32Partition[] | null, plan: FirmwareUpdateWritePlan): void {
  if (!partitions) {
    return
  }
  if (!deviceLayoutMatchesPlan(partitions, plan)) {
    throw new Error(
      'This board is partitioned differently from the published firmware, so its settings partition cannot be ' +
        'spared. Re-enroll it from the "Add frame" panel instead.'
    )
  }
}

export interface BoardUpdate {
  firmware: FirmwareSource
  /** 'esp32-c3' / 'esp32-s3' when the frame knows its chip; else what
   * esptool says it is talking to. */
  knownChip?: string
  /** The image when the board's partition table cannot be read. */
  fallbackPlatform: () => Promise<string>
  /** Pushed once the board answers on the new firmware; none, and the board
   * keeps the scenes it has. */
  scenes?: unknown[] | null
}

export type BoardUpdateOutcome =
  | { status: 'cancelled' }
  | { status: 'failed' }
  /** Written, but the board did not answer afterwards. */
  | { status: 'written'; port: SerialPort; error: string }
  | { status: 'done'; port: SerialPort; image: ReleaseImage; scenesPushed: boolean }

/**
 * Write the release to a board that is ALREADY a frame, around its NVS
 * partition, so it keeps its Wi-Fi credentials and its identity and comes
 * back as the same frame. (The merged image at 0x0 would blank the NVS along
 * with everything else.) See embeddedFlashImage.ts for the write plan and why
 * it is derived from the image's own partition table.
 *
 * Call it from a click handler before any other await (the port prompt).
 */
export async function updateBoardKeepingSettings(
  reporter: FlashReporter,
  update: BoardUpdate
): Promise<BoardUpdateOutcome> {
  let port: SerialPort | null = null
  let session: EspSession | null = null
  let image: ReleaseImage | null = null

  reporter.setPhase('connecting')
  reporter.setProgress(null)
  say(reporter, 'Selecting USB port')
  try {
    port = await takeFlashPort(reporter.frameId)
    if (!port) {
      reporter.setPhase('idle')
      reporter.setMessage(null)
      return { status: 'cancelled' }
    }
    reporter.onPortTaken?.()
    reporter.setPhase('preparing')
    const listing = await update.firmware.listing()
    session = await connectEsp(reporter, port)

    // The board's own partition table picks the image: an update must keep
    // the layout the board has (that is what spares its NVS), and the
    // release publishes one image per layout — a board enrolled on the
    // 16/32 MB image gets that image again, not the generic one. The
    // fallback only when the table cannot be read.
    const log = (line: string): void => appendBrowserFlashLog(reporter.frameId, line)
    const devicePartitions = await readDevicePartitionTable(session.loader, log)
    let platform: string
    if (devicePartitions) {
      const chip = update.knownChip || (/esp32-c3/i.test(session.chip) ? 'esp32-c3' : 'esp32-s3')
      platform = layoutPlatformForPartitions(chip, devicePartitions, listing.assets)
      const mb = partitionTableFlashMb(devicePartitions)
      log(
        mb === null
          ? `The board's partition table matches no published layout; using the ${platform} image.`
          : `The board is partitioned for ${mb}MB: updating with the ${platform} image.`
      )
    } else {
      platform = await update.fallbackPlatform()
    }
    image = await update.firmware.image(platform, listing, (message) => say(reporter, message))
    // Planned and checked against the board before anything is written: a
    // plan that cannot spare the NVS must fail while the flash is untouched.
    const plan = firmwareUpdateWritePlan(image.bytes)
    assertDeviceLayoutMatches(devicePartitions, plan)

    reporter.setPhase('flashing')
    say(
      reporter,
      `Flashing ${image.name} to ${session.chip}, keeping the frame's Wi-Fi and cloud settings (${
        plan.preserved.name
      }, ${Math.round(plan.preserved.size / 1024)}KB).`
    )
    // reportProgress counts per segment; weight them into one bar.
    const segmentOffsets = plan.segments.map((_, index) =>
      plan.segments.slice(0, index).reduce((total, segment) => total + segment.data.byteLength, 0)
    )
    await session.loader.writeFlash({
      fileArray: plan.segments.map((segment) => ({ address: segment.address, data: segment.data })),
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      // eraseAll would take the whole chip, NVS included — the entire point
      // of this flow is that it does not.
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const done = (segmentOffsets[fileIndex] ?? 0) + (total > 0 ? written : 0)
        reporter.setProgress(plan.totalBytes > 0 ? Math.min(100, Math.round((done / plan.totalBytes) * 100)) : null)
      },
    })
  } catch (error) {
    reporter.setProgress(null)
    const detail = error instanceof Error ? error.message : String(error)
    session?.terminal.flush()
    await session?.transport.disconnect().catch(() => undefined)
    if (isPortSelectionCanceled(detail)) {
      reporter.setPhase('idle')
      reporter.setMessage(null)
      return { status: 'cancelled' }
    }
    reporter.setPhase('error')
    const displayMessage = serialFailureMessage(detail)
    reporter.setMessage(displayMessage)
    appendBrowserFlashLog(reporter.frameId, `Firmware update failed: ${displayMessage}`)
    session?.trace.dumpAfterFailure()
    return { status: 'failed' }
  }

  session.trace.expectReboot()
  await resetAfterFlash(session.loader, session.transport)
  reporter.setPhase('preparing')
  reporter.setProgress(null)
  say(reporter, 'Firmware written. Waiting for the board to reboot.')
  session.terminal.flush()
  await session.transport.disconnect().catch(() => undefined)

  try {
    await sleep(POST_FLASH_BOOT_WAIT_MS)
    port = await waitForUsbApiReadyAfterFlash(
      reporter.frameId,
      port,
      (message) => say(reporter, message),
      'Waiting for the board to come back on USB.'
    )
  } catch (error) {
    reporter.setPhase('error')
    const detail = error instanceof Error ? error.message : String(error)
    say(reporter, `Firmware written, but the board did not answer over USB afterwards: ${detail}`)
    return { status: 'written', port, error: detail }
  }
  // Scenes ride the same USB session, after the board answers again: the
  // freshly flashed firmware is what has to accept them. A failure here is
  // reported as its own thing — the firmware update itself already
  // succeeded and must not be reported as failed.
  const scenes = update.scenes ?? []
  if (scenes.length > 0) {
    say(reporter, `Pushing ${scenes.length} scene${scenes.length === 1 ? '' : 's'} over USB.`)
    try {
      await pushScenesOverUsb(reporter.frameId, scenes as Parameters<typeof pushScenesOverUsb>[1])
      reporter.setPhase('done')
      say(
        reporter,
        `Firmware updated and ${pushedScenesMessage(scenes.length).toLowerCase()} ` +
          'The frame kept its Wi-Fi and cloud settings and is reconnecting.'
      )
      return { status: 'done', port, image, scenesPushed: true }
    } catch (pushError) {
      reporter.setPhase('error')
      const detail = pushError instanceof Error ? pushError.message : String(pushError)
      say(reporter, `Firmware updated, but pushing the scenes over USB failed: ${detail}`)
      return { status: 'done', port, image, scenesPushed: false }
    }
  }
  reporter.setPhase('done')
  say(reporter, 'Firmware updated. The frame kept its Wi-Fi and cloud settings and is reconnecting.')
  return { status: 'done', port, image, scenesPushed: false }
}
