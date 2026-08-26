import { ArrowRightIcon, BoltIcon, CheckCircleIcon, CpuChipIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { watchdogResetAfterFlash } from '../../../frontend/src/scenes/workspace/esp32WatchdogReset'
import { loadEsptool } from '../lib/esptool'
import { fetchReleaseListing, releaseLookupErrorFromResponse } from '../lib/release-lookup'
import { clearRememberedWifi, loadRememberedWifi, storeRememberedWifi } from '../lib/remembered-wifi'
import { esp32Panels } from '../lib/generated-devices'
import { cloudFrameUrl } from '../routes'
import { fetchFrameList, useEnrollmentWatch } from './enrollmentWatch'

// Browser flasher for cloud-managed ESP32 frames (docs/cloud-frames.md,
// "ESP32 browser flashing"): WebSerial + esptool-js writes the prebuilt
// GENERIC firmware from the GitHub release (no credentials baked in), then
// provisions cloud_url + claim_token (+ optional WiFi) over the device's
// serial console. The claim token is single-use and short-lived; nothing
// per-user ever enters the firmware binary.
//
// Both the release listing and the firmware bytes come from this cloud's own
// /api/frames/firmware route: GitHub's release redirect sends no CORS headers,
// and unauthenticated api.github.com is rate-limited per IP (one office NAT is
// enough to 403 everyone behind it).
//
// Ported from cloud/apps/auth-web/src/components/Esp32CloudFlasher.tsx; the
// logic is unchanged apart from Tailwind styling and dropping the
// hydration-only "decide support in an effect" dance (this bundle has no SSR).

const firmwareApiUrl = '/api/frames/firmware'
// The generic build carries every supported panel driver and selects one at
// runtime via NVS (`set panel`); releases before the panel table shipped only
// have the single-panel 7.5" V2 build, so that stays as the fallback and the
// panel picker only shows when the release actually publishes the generic
// asset.
const genericPlatform = 'esp32-s3-generic'
const genericC3Platform = 'esp32-c3-generic'
const legacyPlatform = 'esp32-s3-epd7in5v2'
const genericFirmwareSuffix = '-esp32-s3-generic.bin'
const genericC3FirmwareSuffix = '-esp32-c3-generic.bin'

// Hardware picker. Integrated boards are BUNDLES: `set hardware <preset>`
// makes the firmware apply the panel, EPD wiring, GPIO buttons and TF-card
// pins in one shot (the preset table in fos_console.c, mirroring
// EMBEDDED_HARDWARE_PRESETS in the backend). Everything else is a XIAO with
// a bare panel wired to it — the full compiled-in panel table
// (lib/generated-devices) is offered via `set panel`. There is no implicit
// default: nobody actually runs the firmware's baked-in EPD_7in5_V2 combo,
// and silently provisioning any one bundle would misconfigure every other
// board — so the picker starts on a placeholder and flashing requires a
// choice. `platform` picks the firmware asset: ESP32-C3 boards would need the
// esp32-c3-generic build (thin-client only — no PSRAM, so no on-device
// renderer), everything else flashes the esp32-s3-generic one.
//
// ESP32-C3 boards (TRMNL OG/BWRY, XTEINK X4) are deliberately NOT offered
// here yet: a cloud-managed C3 frame has no render source (the cloud's S3
// frames render on-device; thin clients pull bitmaps from a self-hosted
// backend), so flashing one from the cloud would hand the user a status
// screen. Re-add them once the cloud can render for thin clients — the
// platform plumbing below already supports the esp32-c3-generic asset.
const boardChoices = [
  {
    label: 'Waveshare PhotoPainter 7.3" (ESP32-S3 — buttons, SD card)',
    value: 'hw:waveshare_esp32_s3_photopainter',
    platform: genericPlatform,
  },
  {
    label: 'Waveshare PhotoPainter 13.3" (ESP32-S3 — SD card)',
    value: 'hw:waveshare_esp32_s3_epaper_13_3e6',
    platform: genericPlatform,
  },
  { label: 'TRMNL 7.5" DIY Kit (XIAO ESP32-S3)', value: 'hw:trmnl_og_diy_kit', platform: genericPlatform },
  { label: 'TRMNL 4.26" DIY Kit (XIAO ESP32-S3)', value: 'hw:trmnl_4in26_diy_kit', platform: genericPlatform },
  { label: 'Seeed reTerminal Sticky (3.97" ESP32-S3)', value: 'hw:seeed_reterminal_sticky', platform: genericPlatform },
  { label: 'Seeed reTerminal E1001 (7.5" ESP32-S3)', value: 'hw:seeed_reterminal_e1001', platform: genericPlatform },
  {
    label: 'Seeed reTerminal E1002 (7.3" color ESP32-S3)',
    value: 'hw:seeed_reterminal_e1002',
    platform: genericPlatform,
  },
  {
    label: 'Seeed reTerminal E1004 (13.3" color ESP32-S3)',
    value: 'hw:seeed_reterminal_e1004',
    platform: genericPlatform,
  },
  {
    label: 'Elecrow CrowPanel 5.79" (ESP32-S3)',
    value: 'hw:elecrow_crowpanel_5in79',
    platform: genericPlatform,
  },
] as const

// The console's `set pins` spec (fos_config_parse_pins): comma-separated
// key=gpio pairs, -1 meaning "not wired".
const pinKeys = ['rst', 'dc', 'cs', 'cs2', 'busy', 'sck', 'mosi', 'pwr'] as const
const defaultPinsPlaceholder = 'rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1'

export function pinsSpecError(spec: string): string | undefined {
  const trimmed = spec.trim()
  if (!trimmed) {
    return undefined
  }
  for (const pair of trimmed.split(',')) {
    const match = pair.trim().match(/^([a-z0-9]+)=(-?\d+)$/)
    if (!match) {
      return `GPIO pins must be comma-separated key=number pairs, e.g. ${defaultPinsPlaceholder}`
    }
    if (!(pinKeys as readonly string[]).includes(match[1]!)) {
      return `Unknown pin "${match[1]}" — valid pins are ${pinKeys.join(', ')}.`
    }
    const value = Number(match[2])
    if (value < -1 || value > 48) {
      return `Pin ${match[1]} must be a GPIO number between -1 (not wired) and 48.`
    }
  }
  return undefined
}
const flashBaudrate = 460800
const consoleBaudrate = 115200

// The firmware's console answers on both places a board can bring its USB-C
// connector to: the chip's built-in USB-Serial/JTAG device (the port the OS
// names "USB JTAG/serial debug unit" — XIAO ESP32-S3) and UART0 behind an
// on-board USB-UART bridge (Seeed reTerminal E10xx: CH340, the chip's own USB
// pins are not wired at all; the PhotoPainter 13.3" shows both ports over one
// cable). embedded/esp32/sdkconfig.defaults makes UART0 the primary console
// and USB-Serial/JTAG the secondary; fos_console.c reads commands from both.
// The vendor table only names the port kind in the log — nothing is refused.
const uartBridgeVendors: Record<number, string> = {
  0x0403: 'FTDI',
  0x067b: 'Prolific',
  0x10c4: 'Silicon Labs CP210x',
  0x1a86: 'WCH ("USB Single Serial")',
}
const espressifUsbVendorId = 0x303a

export function describeSerialPort(info: { usbVendorId?: number } | undefined): string {
  if (info?.usbVendorId === espressifUsbVendorId) {
    return "the chip's built-in USB-Serial/JTAG port"
  }
  const bridge = info?.usbVendorId !== undefined ? uartBridgeVendors[info.usbVendorId] : undefined
  if (bridge) {
    return `a ${bridge} USB-UART bridge — the console answers on UART0 at ${consoleBaudrate} baud`
  }
  return 'a serial port'
}

// The console prompt has no trailing space (fos_console.c: `printf("frameos>")`).
const consolePrompt = 'frameos>'
// cmd_wifi prints "wifi credentials saved, restarting..." before esp_restart().
const rebootNotice = 'restarting'
const bootPromptTimeoutMs = 20000
const commandPromptTimeoutMs = 10000
const rebootAckTimeoutMs = 5000

// 802.11 limits, and both fit the device's 128-byte config fields.
const maxSsidLength = 32
const maxPasswordLength = 64
// A newline would end the console line and start a second command; no other
// control character survives the serial console either. (A character class
// would say the same, but eslint's no-control-regex bans it in a regex.)
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

type FlashPhase = 'idle' | 'fetching' | 'connecting' | 'flashing' | 'provisioning' | 'done' | 'error'

interface SerialPortLike {
  // Absent before Chrome 117; `undefined` must count as possibly-connected.
  connected?: boolean
  getInfo?(): { usbProductId?: number; usbVendorId?: number }
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
}

interface WebSerialLike {
  getPorts?(): Promise<SerialPortLike[]>
  requestPort(): Promise<SerialPortLike>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The RTC-watchdog post-flash reset is shared with the workspace flashers:
// frontend/src/scenes/workspace/esp32WatchdogReset.ts (this bundle already
// deep-imports frontend/src — see main.tsx). It exists because a DTR/RTS
// reset pulse goes through the USB-Serial/JTAG strap logic, which on some
// boards (XIAO ESP32-S3) latches the chip back into ROM download mode — the
// flash "succeeds" but the app never boots, so provisioning times out waiting
// for a console that will never come (arduino-esp32#6762).

// A watchdog reset re-enumerates the USB device: the SerialPort object the
// user picked goes permanently stale (every open() fails with NetworkError).
// The replacement device inherits the permission grant, so it shows up in
// getPorts() — take it when it is the only plausible match, and never guess
// between two boards that share a vendor/product id.
async function findReplacementPort(
  serial: WebSerialLike,
  original: SerialPortLike
): Promise<SerialPortLike | undefined> {
  if (!serial.getPorts) {
    return undefined
  }
  let ports: SerialPortLike[]
  try {
    ports = await serial.getPorts()
  } catch {
    return undefined
  }
  const info = original.getInfo?.()
  const candidates = ports.filter((port) => {
    if (port === original || port.connected === false) {
      return false
    }
    if (!info || !port.getInfo) {
      return true
    }
    const candidateInfo = port.getInfo()
    return candidateInfo.usbVendorId === info.usbVendorId && candidateInfo.usbProductId === info.usbProductId
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

// Re-enumeration takes a couple of seconds; keep retrying the open until the
// board is back (or was never gone — the first attempt usually just works).
const consoleReopenTimeoutMs = 20000
const consoleReopenPollMs = 1000

async function openConsolePort(serial: WebSerialLike, original: SerialPortLike): Promise<SerialPortLike> {
  const deadline = Date.now() + consoleReopenTimeoutMs
  let candidate = original
  for (;;) {
    try {
      await candidate.open({ baudRate: consoleBaudrate })
      return candidate
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error
      }
    }
    const replacement = await findReplacementPort(serial, original)
    if (replacement) {
      candidate = replacement
    }
    await sleep(consoleReopenPollMs)
  }
}

interface ConsoleCommand {
  // What to show in the log — secrets are redacted there, not on the wire.
  display: string
  // Substring the console prints back once the command took effect: its prompt
  // after `set`, the reboot notice after `wifi`, nothing at all after
  // `restart` (cmd_restart resets without printing anything).
  expect: string | undefined
  // Whether a missing acknowledgement means the command failed. Reboot
  // commands print theirs while the board is already resetting, so that line
  // can legitimately be lost in the USB TX buffer.
  required: boolean
  text: string
}

// esp_console_split_argv (ESP-IDF components/console/split_argv.c, reached via
// esp_console_run in fos_console.c) understands double quotes and backslash
// escapes: inside "…" a space is a literal space, and the only recognized
// escapes are \\, \" and backslash-space — any other escape is silently
// dropped, so nothing else may be emitted. Quoting the
// whole value and escaping backslashes and quotes is exactly expressible, and
// an SSID like `My Home WiFi` arrives as one argv entry.
function quoteConsoleArgument(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`
}

// Validated before anything is downloaded or flashed: half-provisioning a
// board and then failing is much worse than refusing up front.
export function wifiInputError(ssid: string, password: string): string | undefined {
  if (hasControlCharacter(ssid) || hasControlCharacter(password)) {
    return "WiFi name and password can't contain line breaks or control characters."
  }
  if (ssid.length > maxSsidLength) {
    return `WiFi network name must be at most ${maxSsidLength} characters.`
  }
  if (password.length > maxPasswordLength) {
    return `WiFi password must be at most ${maxPasswordLength} characters.`
  }
  if (!ssid && password) {
    return 'Enter the WiFi network name for that password.'
  }
  return undefined
}

interface FirmwareAsset {
  name: string
  platform: string
  size: number
}

async function fetchGenericFirmware(platform: string, log: (line: string) => void): Promise<Uint8Array> {
  log('Looking up the latest FrameOS release…')
  const release = await fetchReleaseListing<{
    assets?: FirmwareAsset[]
    release?: string
  }>(firmwareApiUrl)
  // Prefer the requested chip's all-panels build; for ESP32-S3 fall back to
  // the single-panel build that releases before the runtime driver table
  // published. There is no legacy ESP32-C3 build to fall back to.
  const asset =
    release.assets?.find((entry) => entry.platform === platform) ??
    (platform === genericPlatform ? release.assets?.find((entry) => entry.platform === legacyPlatform) : undefined)
  if (!asset) {
    const suffix = platform === genericC3Platform ? genericC3FirmwareSuffix : genericFirmwareSuffix
    throw new Error(
      `Release ${
        release.release || '?'
      } has no ${suffix} asset yet — it ships with the first release after cloud frames landed. You can flash manually via embedded/esp32 instead.`
    )
  }
  log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)…`)
  const firmwareResponse = await fetch(`${firmwareApiUrl}?platform=${encodeURIComponent(asset.platform)}`)
  if (!firmwareResponse.ok) {
    throw await releaseLookupErrorFromResponse(firmwareResponse, 'firmware download')
  }
  return new Uint8Array(await firmwareResponse.arrayBuffer())
}

// Send console commands over the freshly flashed firmware's serial REPL and
// wait for its prompt output. The console echoes results; we scan for
// substrings rather than parsing the esp_console framing. The port arrives
// already opened (openConsolePort handles post-reset re-enumeration) and is
// closed here on every path.
async function provisionOverSerial(
  port: SerialPortLike,
  commands: ConsoleCommand[],
  log: (line: string) => void
): Promise<void> {
  const writer = port.writable?.getWriter()
  const reader = port.readable?.getReader()
  try {
    if (!writer || !reader) {
      throw new Error('Serial port has no readable/writable stream')
    }
    const decoder = new TextDecoder()
    let buffer = ''
    // Exactly one read() may be outstanding at a time. Racing a fresh read()
    // against a timer and walking away leaves that read pending — it still
    // resolves later, and its chunk (possibly the one carrying the prompt) is
    // lost. So the pending promise is kept and re-awaited until it settles.
    let pendingRead: Promise<{ result: ReadableStreamReadResult<Uint8Array>; tag: 'read' }> | undefined
    const readUntil = async (needle: string, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs
      if (buffer.includes(needle)) {
        return true
      }
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          return false
        }
        pendingRead ??= reader.read().then((result) => ({ result, tag: 'read' as const }))
        let timer: ReturnType<typeof setTimeout> | undefined
        const outcome = await Promise.race([
          pendingRead,
          new Promise<{ tag: 'timeout' }>((resolve) => {
            timer = setTimeout(() => resolve({ tag: 'timeout' }), remaining)
          }),
        ])
        clearTimeout(timer)
        if (outcome.tag === 'timeout') {
          // Keep pendingRead: its bytes are still coming.
          continue
        }
        pendingRead = undefined
        if (outcome.result.done) {
          // The device closed the stream; no further bytes will arrive.
          return buffer.includes(needle)
        }
        if (outcome.result.value) {
          buffer += decoder.decode(outcome.result.value, { stream: true })
          if (buffer.includes(needle)) {
            return true
          }
        }
      }
    }

    // Wait for the console to come up after reset (boot logs then prompt).
    log('Waiting for the FrameOS console…')
    if (!(await readUntil(consolePrompt, bootPromptTimeoutMs))) {
      throw new Error(
        'The flashed firmware never showed its FrameOS console prompt, so nothing was provisioned. ' +
          'Unplug the board, plug it back in and try again; if the port picker lists several ports, ' +
          'try the other one ("USB JTAG/serial debug unit" or "USB Single Serial" — the console answers on both).'
      )
    }
    for (const command of commands) {
      log(`> ${command.display}`)
      buffer = ''
      await writer.write(new TextEncoder().encode(command.text + '\n'))
      if (command.expect === undefined) {
        continue
      }
      const acknowledged = await readUntil(
        command.expect,
        command.required ? commandPromptTimeoutMs : rebootAckTimeoutMs
      )
      if (acknowledged) {
        continue
      }
      if (command.required) {
        // Every result used to be discarded, so a board that never booted a
        // console was still reported as provisioned.
        throw new Error(
          `The frame never acknowledged \`${command.display}\`, so it is not fully provisioned. Try flashing again.`
        )
      }
      log('(No reboot confirmation seen — the board may have reset before it finished printing.)')
    }
  } finally {
    // Hand the streams back even when a step threw, or the port stays locked
    // and the offered retry fails with "port already open" until a replug.
    if (reader) {
      try {
        await reader.cancel()
      } catch {
        // Already errored/closed — nothing to cancel.
      }
      try {
        reader.releaseLock()
      } catch {
        // Ditto.
      }
    }
    try {
      writer?.releaseLock()
    } catch {
      // Ditto.
    }
    try {
      await port.close()
    } catch {
      // Some firmware resets close the port on their own.
    }
  }
}

const controlClassName =
  'frameos-control block w-full rounded-lg border px-2.5 py-1.5 text-sm focus:border-blue-500 focus:ring-blue-500 disabled:opacity-50'

export function Esp32CloudFlasher({
  cloudOrigin,
  reenrollFrame,
  sceneSourceFrameId,
}: {
  // Provisioned into the board's NVS as cloud_url, so it must be the
  // deployment's public URL, not whatever host the browser is pointed at.
  cloudOrigin: string
  // Re-enrollment mode: rebuild an EXISTING frame's identity on this board
  // instead of enrolling a new one. The claim token is minted bound to this
  // frame id, so redemption re-keys that row (docs/cloud-frames.md,
  // "Re-enrollment") — which also means there is no new frame to watch for
  // and no name to ask for: both already exist.
  reenrollFrame?: { id: string; name: string }
  // "Start it with the scenes from <frame>", chosen in the add-frame panel.
  // Rides on the claim code and is applied when the owner confirms the new
  // frame; ignored in re-enrollment mode, where the frame keeps its own.
  sceneSourceFrameId?: string | undefined
}): ReactElement {
  const [phase, setPhase] = useState<FlashPhase>('idle')
  // Each enrollment path names its own frame — the SD builder keeps its own
  // field too — so the name sits next to the flash button that uses it,
  // instead of floating at the top of the panel.
  const [frameName, setFrameName] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [progress, setProgress] = useState(0)
  const cloudUrl = cloudOrigin
  const remembered = useRef(loadRememberedWifi()).current
  const [wifiSsid, setWifiSsid] = useState(remembered?.ssid ?? '')
  const [wifiPassword, setWifiPassword] = useState(remembered?.password ?? '')
  const [rememberWifi, setRememberWifi] = useState(remembered !== undefined)
  const [error, setError] = useState<string | undefined>()
  // Panel selection needs the all-panels firmware; the picker only shows when
  // the latest release actually publishes it (older releases hard-fail the
  // display init on a panel other than the one compiled in).
  const [panelSelectable, setPanelSelectable] = useState(false)
  const [panelChoice, setPanelChoice] = useState('')
  // Optional GPIO override, like the backend frame settings: applied after
  // the hardware/panel choice, so it wins over a preset's wiring.
  const [pinsSpec, setPinsSpec] = useState('')
  const busyRef = useRef(false)
  const logRef = useRef<HTMLPreElement | null>(null)
  // The frames that already existed when this flash started (snapshotted just
  // before the claim token is minted, so the enrolled frame can never be in
  // it). null = no usable snapshot; then the panel does not guess.
  const [knownFrameIds, setKnownFrameIds] = useState<ReadonlySet<string> | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchReleaseListing<{ assets?: FirmwareAsset[] }>(firmwareApiUrl)
      .then((release) => {
        if (!cancelled && release.assets?.some((entry) => entry.platform === genericPlatform)) {
          setPanelSelectable(true)
        }
      })
      .catch(() => {
        // The flash flow does its own lookup with real error reporting; a
        // failed probe here only means the picker stays hidden.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // What to provision for the chosen hardware: a whole-board preset via
  // `set hardware`, or a bare panel via `set panel`.
  const provisionKey = panelChoice.replace(/^(hw|panel):/, '')
  const provisionCommand = panelChoice.startsWith('hw:') ? 'hardware' : 'panel'
  // Which firmware asset the chosen hardware needs. Bare panels are wired to
  // a XIAO ESP32-S3; board bundles carry their chip in boardChoices.
  const firmwarePlatform =
    boardChoices.find((choice) => choice.value === panelChoice)?.platform ?? genericPlatform

  // The handoff to the freshly enrolled frame: once provisioning is done the
  // board reboots and enrolls on its own schedule, so watch the frames list
  // until a frame appears that predates nothing — then offer to open it.
  // Without a snapshot there is no telling old frames from new; stay quiet.
  const { enrolledFrame, hintDue } = useEnrollmentWatch({
    active: phase === 'done' && knownFrameIds !== null && !reenrollFrame,
    knownFrameIds,
  })

  // WebSerial support cannot change while the page is open, so probe it once.
  // (The Next.js version deferred this to an effect purely to keep SSR and
  // hydration rendering the same fallback; there is no SSR here.)
  const [supported] = useState(() => typeof navigator !== 'undefined' && 'serial' in navigator)

  function log(line: string): void {
    setLines((previous) => [...previous.slice(-200), line])
  }

  // Follow the log while a flash runs: the interesting lines (enrollment,
  // reboot wait, the frame handoff) land after the box has filled its
  // max-height, so without this they appear below the fold. Stick to the
  // bottom only when the view is already there — a user who scrolled up to
  // re-read an earlier line must not be yanked back down by the next one.
  useEffect(() => {
    const el = logRef.current
    if (!el) {
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 80) {
      el.scrollTop = el.scrollHeight
    }
  }, [lines])

  // Enrollment codes are plumbing, not UX: mint a fresh single-use code per
  // flash, provision it over serial, never show it to the user. In
  // re-enrollment mode the code is bound to the frame being rebuilt, and the
  // cloud echoes that id back — assert it, because provisioning a board with
  // a code for the wrong frame is exactly the duplicate this mode prevents.
  async function mintEnrollmentCode(): Promise<string> {
    const response = await fetch('/api/frames/claim-tokens', {
      body: JSON.stringify(
        reenrollFrame
          ? { frame_id: reenrollFrame.id }
          : {
              name: frameName.trim(),
              ...(sceneSourceFrameId ? { scene_source_frame_id: sceneSourceFrameId } : {}),
            }
      ),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const data = (await response.json().catch(() => ({}))) as {
      claim_token?: string
      error?: string
      frame_id?: string
    }
    if (!response.ok || !data.claim_token) {
      throw new Error(
        data.error === 'frame_quota_exceeded'
          ? "You've reached the frame limit for this account."
          : data.error === 'frame_revoked'
          ? 'This frame has been revoked — delete it and add the board as a new frame.'
          : data.error === 'invalid_frame'
          ? 'This frame no longer exists in your account.'
          : 'Could not prepare the enrollment — are you still signed in?'
      )
    }
    if (reenrollFrame && data.frame_id !== reenrollFrame.id) {
      throw new Error('The cloud issued an enrollment for a different frame; nothing was provisioned.')
    }
    return data.claim_token
  }

  async function flash(): Promise<void> {
    if (busyRef.current) {
      return
    }
    const inputError = wifiInputError(wifiSsid, wifiPassword)
    if (inputError) {
      setError(inputError)
      setPhase('error')
      return
    }
    const pinsError = panelSelectable ? pinsSpecError(pinsSpec) : undefined
    if (pinsError) {
      setError(pinsError)
      setPhase('error')
      return
    }
    // Re-enrollment reuses the existing frame's name; there is nothing to ask.
    if (!reenrollFrame && !frameName.trim()) {
      setError('Name the frame first — that is how it shows up in this workspace.')
      setPhase('error')
      return
    }
    if (panelSelectable && !panelChoice) {
      setError('Pick the frame hardware first — your board, or the e-paper panel wired to your ESP32.')
      setPhase('error')
      return
    }
    if (rememberWifi && wifiSsid) {
      storeRememberedWifi(wifiSsid, wifiPassword)
    } else {
      clearRememberedWifi()
    }
    busyRef.current = true
    setLines([])
    setError(undefined)
    setProgress(0)
    setKnownFrameIds(null)
    try {
      setPhase('fetching')
      const firmware = await fetchGenericFirmware(firmwarePlatform, log)

      setPhase('connecting')
      log('Pick the USB serial port of your ESP32 — if several are listed, "USB JTAG/serial debug unit" is the faster one…')
      const serial = (navigator as unknown as { serial: WebSerialLike }).serial
      const port = await serial.requestPort()
      log(`Selected ${describeSerialPort(port.getInfo?.())}.`)

      setPhase('flashing')
      const { ESPLoader, Transport } = await loadEsptool()
      // esptool-js 0.6 takes the firmware as a Uint8Array, NOT the binary
      // string of the 0.4 API. A string here reaches pako's deflate(), which
      // UTF-8-encodes it: every byte >= 0x80 becomes two bytes, the stub
      // decompresses more data than flashDeflBegin declared, and every attempt
      // dies with "Failed to write compressed data to flash … status 201"
      // (0xC9, ESP_TOO_MUCH_DATA) — while writing garbage to flash on the way.

      // Writing 3 MB over a flaky USB-serial link fails part-way often enough
      // to matter: a bad cable, a hub, or a board whose bridge does not keep up
      // at 460800 gives "Failed to write compressed data to flash after seq N"
      // and the port drops. None of that means the firmware is wrong, so retry
      // slower before giving up. Both attempts stay compressed: esptool-js 0.6
      // throws "Yet to handle Non Compressed writes" on compress: false.
      const attempts = [
        { baudrate: flashBaudrate, label: 'fast' },
        { baudrate: 115200, label: 'slower' },
      ]
      let flashed = false
      let lastError: unknown
      for (const [index, attempt] of attempts.entries()) {
        if (index > 0) {
          log(`Retrying at ${attempt.baudrate} baud (${attempt.label})…`)
          setProgress(0)
        }
        const transport = new Transport(port as never, false)
        const loader = new ESPLoader({
          baudrate: attempt.baudrate,
          romBaudrate: 115200,
          transport,
        } as never)
        try {
          await loader.main()
          log(`Connected: ${loader.chip?.CHIP_NAME ?? 'ESP32'}`)
          await loader.writeFlash({
            compress: true,
            eraseAll: false,
            fileArray: [{ address: 0x0, data: firmware }],
            flashFreq: 'keep',
            flashMode: 'keep',
            flashSize: 'keep',
            reportProgress: (_index: number, written: number, total: number) => {
              setProgress(Math.round((written / total) * 100))
            },
            // No cast: FlashOptions is what catches a data-type regression here.
          })
          log('Firmware written. Resetting…')
          // Watchdog reset first — a DTR/RTS pulse straps some USB-Serial/JTAG
          // boards back into ROM download mode (see watchdogResetAfterFlash).
          // Non-S3 chips get the classic reset pulse instead; esptool-js's own
          // after() never asserts RTS, so it would not reset the board at all.
          if (!(await watchdogResetAfterFlash(loader))) {
            try {
              await transport.setDTR(false)
              await transport.setRTS(true)
              await sleep(100)
              await transport.setRTS(false)
            } catch {
              // The port drops if the chip resets mid-command; provisioning
              // re-acquires it.
            }
          }
          flashed = true
        } catch (error) {
          lastError = error
          log(`Flash attempt failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          // Always give the port back, including on a mid-flash throw:
          // esptool-js holds the WebSerial reader/writer, and the next attempt
          // (or provisioning) needs to reopen the same port.
          try {
            await transport.disconnect()
          } catch {
            // Never mask the flash error with a teardown error.
          }
        }
        if (flashed) {
          break
        }
      }
      if (!flashed) {
        const detail = lastError instanceof Error ? lastError.message : String(lastError)
        throw new Error(
          `${detail}. The firmware itself is fine — this is the USB link giving out part-way. ` +
            'Try a different USB cable (charge-only cables are a common culprit), plug the board ' +
            'straight into the computer rather than through a hub, and if it still stops, hold BOOT ' +
            'while connecting.',
        )
      }

      setPhase('provisioning')
      // Minted here, not at the start: claim tokens are single-use and there is
      // no revoke endpoint, so minting before the download/connect/flash burned
      // one code per failed attempt. Now nothing is spent unless the firmware
      // is actually on the board and only the serial handshake is left.
      log('Preparing a one-time enrollment for this frame…')
      if (!reenrollFrame) {
        // Snapshot the fleet BEFORE the claim token exists: whatever frame
        // appears beyond this set can only be the one this flash enrolls. A
        // failed snapshot (undefined) just disables the automatic handoff.
        // Re-enrollment needs none of this — no frame is created, and the row
        // to report against is the one the user started from.
        const framesBeforeEnrollment = await fetchFrameList()
        setKnownFrameIds(framesBeforeEnrollment ? new Set(framesBeforeEnrollment.map((frame) => frame.id)) : null)
      }
      const token = await mintEnrollmentCode()
      const commands: ConsoleCommand[] = [
        {
          display: `set cloud_url ${cloudUrl}`,
          expect: consolePrompt,
          required: true,
          text: `set cloud_url ${quoteConsoleArgument(cloudUrl)}`,
        },
        {
          display: 'set claim_token (redacted)',
          expect: consolePrompt,
          required: true,
          text: `set claim_token ${quoteConsoleArgument(token)}`,
        },
      ]
      if (panelSelectable && provisionKey) {
        // The all-panels firmware resolves the driver from NVS at boot, and
        // `set hardware` applies a whole board bundle (panel, pins, buttons,
        // SD card). The console rejects panel keys its table does not know,
        // which fails the flash loudly instead of leaving a frame that
        // renders to nothing.
        commands.push({
          display: `set ${provisionCommand} ${provisionKey}`,
          expect: consolePrompt,
          required: true,
          text: `set ${provisionCommand} ${quoteConsoleArgument(provisionKey)}`,
        })
      }
      if (panelSelectable && pinsSpec.trim()) {
        // After the hardware/panel command on purpose: a preset applies its
        // own wiring, and an explicit override must win.
        commands.push({
          display: `set pins ${pinsSpec.trim()}`,
          expect: consolePrompt,
          required: true,
          text: `set pins ${quoteConsoleArgument(pinsSpec.trim())}`,
        })
      }
      if (wifiSsid) {
        // `wifi` saves credentials and reboots; enrollment starts on boot.
        commands.push({
          display: wifiPassword ? `wifi ${wifiSsid} (password redacted)` : `wifi ${wifiSsid}`,
          expect: rebootNotice,
          required: false,
          text: wifiPassword
            ? `wifi ${quoteConsoleArgument(wifiSsid)} ${quoteConsoleArgument(wifiPassword)}`
            : `wifi ${quoteConsoleArgument(wifiSsid)}`,
        })
      } else {
        commands.push({
          display: 'restart',
          expect: undefined,
          required: false,
          text: 'restart',
        })
      }
      log('Waiting for the board to come back after reset…')
      const consolePort = await openConsolePort(serial, port)
      await provisionOverSerial(consolePort, commands, log)

      setPhase('done')
      log(
        reenrollFrame
          ? wifiSsid
            ? `Done. The board joins WiFi and links back to "${reenrollFrame.name}" — its scenes and settings are already there.`
            : `Done. Connect the board to WiFi (serial: \`wifi <ssid> <pass>\` or the FrameOS-Setup portal); it then links back to "${reenrollFrame.name}".`
          : wifiSsid
          ? 'Done. The frame joins WiFi, enrolls, and appears in this workspace as pending — confirm it there.'
          : 'Done. Connect the frame to WiFi (serial: `wifi <ssid> <pass>` or the FrameOS-Setup portal); it then enrolls and appears in this workspace as pending.'
      )
    } catch (flashError) {
      const message = flashError instanceof Error ? flashError.message : String(flashError)
      setPhase('error')
      setError(message)
      log(`Error: ${message}`)
    } finally {
      busyRef.current = false
    }
  }

  if (!supported) {
    return (
      <p className="frameos-muted flex items-start gap-1.5 text-xs">
        <CpuChipIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Browser flashing needs WebSerial (Chrome/Edge on desktop). You can still provision over a serial console — see
          the ESP32 docs.
        </span>
      </p>
    )
  }

  const busy = phase !== 'idle' && phase !== 'error' && phase !== 'done'

  return (
    <div className="space-y-2">
      <p className="frameos-muted text-xs">
        {reenrollFrame
          ? `Plug the board in over USB and click flash — it writes the generic FrameOS firmware and links the board back to "${reenrollFrame.name}", keeping that frame's scenes, assets and logs.`
          : 'Plug the board in over USB and click flash — it writes the generic FrameOS firmware and links the frame to this account automatically.'}{' '}
        If the port picker lists several ports, either works &mdash; &ldquo;USB JTAG/serial debug unit&rdquo; is the
        faster one; &ldquo;USB Single Serial&rdquo; is the board&rsquo;s USB-UART bridge at 115200 baud.
      </p>
      <div className="grid gap-2">
        {reenrollFrame ? null : (
          <input
            aria-label="Frame name"
            className={controlClassName}
            disabled={busy}
            maxLength={256}
            onChange={(event) => setFrameName(event.target.value)}
            placeholder="Frame name"
            required
            value={frameName}
          />
        )}
        {!panelSelectable ? (
          <p className="frameos-muted text-xs">
            This release&apos;s firmware drives the Waveshare 7.5&quot; V2 panel; picking a different e-paper panel at
            flash time arrives with the next FrameOS release (the board can still be re-pointed later via its serial
            console or setup portal).
          </p>
        ) : null}
        {panelSelectable ? (
          <>
            <select
              aria-label="Frame hardware"
              className={controlClassName}
              disabled={busy}
              onChange={(event) => setPanelChoice(event.target.value)}
              value={panelChoice}
            >
              <option disabled value="">
                Choose your board or e-paper panel…
              </option>
              <optgroup label="Integrated boards">
                {boardChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Seeed XIAO ESP32-S3 + Waveshare panel">
                {esp32Panels.map((panel) => (
                  <option key={panel.key} value={`panel:${panel.key}`}>
                    {panel.label}
                  </option>
                ))}
              </optgroup>
            </select>
            <input
              aria-label="GPIO pins (optional)"
              className={controlClassName}
              disabled={busy}
              maxLength={128}
              onChange={(event) => setPinsSpec(event.target.value)}
              placeholder={`GPIO pins (optional — e.g. ${defaultPinsPlaceholder})`}
              value={pinsSpec}
            />
          </>
        ) : null}
        <input
          aria-label="WiFi network"
          className={controlClassName}
          disabled={busy}
          maxLength={maxSsidLength}
          onChange={(event) => setWifiSsid(event.target.value)}
          placeholder="WiFi network (optional — portal works too)"
          value={wifiSsid}
        />
        <input
          aria-label="WiFi password"
          className={controlClassName}
          disabled={busy}
          maxLength={maxPasswordLength}
          onChange={(event) => setWifiPassword(event.target.value)}
          placeholder="WiFi password"
          type="password"
          value={wifiPassword}
        />
        <label className="frameos-muted flex items-center gap-2 text-xs">
          <input
            checked={rememberWifi}
            disabled={busy}
            onChange={(event) => {
              setRememberWifi(event.target.checked)
              if (!event.target.checked) {
                clearRememberedWifi()
              }
            }}
            type="checkbox"
          />
          Remember WiFi credentials in this browser (never sent to the cloud)
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            onClick={() => void flash()}
            type="button"
          >
            <BoltIcon aria-hidden className="h-4 w-4" />
            {phase === 'flashing'
              ? `Flashing ${progress}%`
              : phase === 'provisioning'
              ? 'Provisioning…'
              : phase === 'fetching' || phase === 'connecting'
              ? 'Preparing…'
              : reenrollFrame
              ? 'Connect & re-enroll'
              : 'Connect & flash'}
          </button>
        </div>
      </div>
      {error ? (
        <p className="frameos-warning-button rounded-xl border px-3 py-2 text-xs" role="alert">
          {error}
        </p>
      ) : null}
      {phase === 'done' ? (
        <div
          data-testid="esp32-flash-done"
          className={
            reenrollFrame || enrolledFrame || knownFrameIds
              ? 'frameos-card space-y-2 rounded-xl border p-3'
              : undefined
          }
        >
          {reenrollFrame ? (
            // No frame watch: nothing new is created, so success is reported
            // against the row the user started from. The board reconnects on
            // its own schedule and the workspace shows it online then.
            <p className="frameos-strong flex items-start gap-1.5 text-sm font-semibold">
              <CheckCircleIcon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
              <span>
                &ldquo;{reenrollFrame.name}&rdquo; is provisioned onto this board. It comes back online here once it
                reaches WiFi — no confirmation needed.
              </span>
            </p>
          ) : enrolledFrame ? (
            <>
              <p className="frameos-strong flex items-start gap-1.5 text-sm font-semibold">
                <CheckCircleIcon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                <span>
                  Frame &ldquo;{enrolledFrame.name || 'New frame'}&rdquo; enrolled
                  {enrolledFrame.status === 'pending' ? ' and is waiting for your confirmation' : ''}.
                </span>
              </p>
              <a
                data-testid="esp32-flash-open-frame"
                className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                href={cloudFrameUrl(enrolledFrame.id)}
              >
                Open frame
                <ArrowRightIcon aria-hidden className="h-4 w-4" />
              </a>
            </>
          ) : knownFrameIds ? (
            <>
              <p className="frameos-muted text-xs">
                Watching for the frame to enroll — the moment it phones home it appears here (and in the workspace as
                pending).
              </p>
              {hintDue ? (
                <p className="frameos-muted text-xs">
                  Nothing yet — check the board has power and can reach your WiFi (its console over USB shows what it
                  is doing). The enrollment stays valid: the frame appears here whenever it reaches the cloud.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {lines.length > 0 ? (
        <pre
          ref={logRef}
          className="frameos-inset max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[11px] leading-relaxed"
          role="status"
        >
          {lines.join('\n')}
        </pre>
      ) : null}
    </div>
  )
}
