import { Form } from 'kea-forms'
import { useActions, useValues } from 'kea'
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowUpTrayIcon,
  CommandLineIcon,
  ComputerDesktopIcon,
  CpuChipIcon,
  ServerStackIcon,
} from '@heroicons/react/24/outline'
import { ExclamationCircleIcon } from '@heroicons/react/24/solid'
import {
  BUILDROOT_RASPBERRY_PI_64,
  EMBEDDED_ESP32_C3,
  EMBEDDED_ESP32_S3,
  EMBEDDED_PICO_2W,
  EMBEDDED_PICO_W,
  EMBEDDED_VIRTUAL,
  devices,
  partialRefreshDefaultsByDevice,
  partialRefreshDevices,
  buildrootPlatforms,
  embeddedPlatforms,
  isThinClientEmbeddedPlatform,
  rpiOSPlatforms,
  virtualColorModes,
} from '../../devices'
import { defaultRemoteControl, newFrameForm } from './newFrameForm'
import {
  FrameEmbeddedHardwarePreset,
  FrameInstallMethod,
  FrameOSSettings,
  FrameVirtualColorMode,
  GPIOButton,
  NewFrameFormType,
} from '../../types'
import { settingsLogic } from '../settings/settingsLogic'
import { normalizedTimezone } from '../../utils/timezone'
import { timezoneOptions } from '../../decorators/timezones'
import { Spinner } from '../../components/Spinner'
import { Field } from '../../components/Field'
import { Checkbox } from '../../components/Checkbox'
import { Switch } from '../../components/Switch'
import { Tooltip } from '../../components/Tooltip'
import { PartialRefreshSettingsFields } from '../../components/PartialRefreshSettingsFields'
import { getDefaultSshKeyIds, normalizeSshKeys } from '../../utils/sshKeys'
import { urls } from '../../urls'
import { defaultNewFrameServerHost } from '../../utils/backendAddress'

function isLocalServer(host?: string | null): boolean {
  const localHostRegex = /^(localhost|0\.0\.0\.0|127\.0\.0\.1|\[::1\])(:\d+)?$/
  return !!host && localHostRegex.test(host)
}

function errorText(error: unknown): string | null {
  if (!error) {
    return null
  }
  return String(error)
}

function ModeButton({
  children,
  onClick,
  title,
  description,
}: {
  children: JSX.Element | string
  onClick: () => void
  title: string
  description: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="frameos-install-method-button frameos-segment flex flex-1 flex-col items-start justify-start rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-left text-slate-600 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        {children}
        {title}
      </span>
      <span className="mt-1 text-xs leading-4 text-slate-500">{description}</span>
    </button>
  )
}

// The frame is reachable in one of two directions, and which one decides how
// every later deploy, restart and screenshot gets to it. Making the choice
// explicit at add time beats discovering it when a deploy fails: a frame on a
// network the backend cannot dial needs Remote, and a frame you would rather
// not have phoning home can stay SSH-only.
function RemoteControlField({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
}): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="frameos-form-label text-sm font-semibold text-slate-700">FrameOS remote control</div>
        <Tooltip
          className="inline-flex h-5 w-5 items-center justify-center rounded-full"
          titleClassName="w-72"
          title={
            <div className="space-y-1">
              <div>
                FrameOS Remote is a reverse tunnel: the frame connects out to this backend and holds the connection
                open, so it works from behind NAT, on another network, or without a reachable address.
              </div>
              <div>
                With it off, this backend has to reach the frame directly on your network — SSH for deploys and
                commands, HTTP to the frame's own web server for screenshots and events.
              </div>
              <div>You can change this later in frame settings.</div>
            </div>
          }
        >
          <ExclamationCircleIcon className="h-4 w-4" aria-label="FrameOS remote control help" />
        </Tooltip>
      </div>
      <div className="frame-tool-panel">
        <div className="flex min-w-0 items-center gap-2">
          <Switch value={enabled} onChange={onChange} />
          <div className="min-w-0 flex-1 text-sm text-slate-700">
            {enabled
              ? 'Enabled — the frame connects back to this backend and waits for commands'
              : 'Disabled — this backend reaches the frame'}
          </div>
        </div>
      </div>
    </div>
  )
}

function FormField({
  label,
  error,
  children,
  hint,
}: {
  label: JSX.Element | string
  error?: unknown
  children: JSX.Element
  hint?: JSX.Element | string | null
}): JSX.Element {
  const resolvedError = errorText(error)
  return (
    <label className="block space-y-2">
      <span className="frameos-form-label block text-sm font-semibold text-slate-700">{label}</span>
      {children}
      {hint ? <span className="frameos-form-hint block text-xs leading-relaxed text-slate-500">{hint}</span> : null}
      {resolvedError ? <span className="block text-xs font-semibold text-red-500">{resolvedError}</span> : null}
    </label>
  )
}

function textInputClassName(): string {
  return 'frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30'
}

function selectClassName(): string {
  return 'frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30'
}

function defaultWifiNetwork(settings: FrameOSSettings): NonNullable<NewFrameFormType['network']> {
  return {
    wifiSSID: settings.defaults?.wifiSSID ?? '',
    wifiPassword: settings.defaults?.wifiPassword ?? '',
  }
}

function defaultInstallSshKeyIds(settings: FrameOSSettings): string[] {
  const defaultIds = getDefaultSshKeyIds(settings.ssh_keys)
  if (defaultIds.length > 0) {
    return defaultIds
  }
  return normalizeSshKeys(settings.ssh_keys).keys.map((key) => key.id)
}

function setInstallMethodValues(
  installMethod: FrameInstallMethod,
  savedSettings: FrameOSSettings
): Partial<NewFrameFormType> {
  if (installMethod === 'sd_card') {
    return {
      install_method: installMethod,
      mode: 'buildroot',
      platform: BUILDROOT_RASPBERRY_PI_64,
      frame_host: '',
      server_host: defaultNewFrameServerHost(savedSettings),
      network: defaultWifiNetwork(savedSettings),
      rememberWifi: true,
    }
  }
  if (installMethod === 'embedded') {
    return {
      install_method: installMethod,
      mode: 'embedded',
      platform: EMBEDDED_ESP32_S3,
      frame_host: '',
      server_host: defaultNewFrameServerHost(savedSettings),
      // "none" = headless firmware (panel "none"); a real panel is opt-in.
      device: 'none',
      network: defaultWifiNetwork(savedSettings),
      rememberWifi: true,
    }
  }
  if (installMethod === 'script') {
    return {
      install_method: installMethod,
      mode: 'rpios',
      platform: '',
      frame_host: '',
      server_host: defaultNewFrameServerHost(savedSettings),
    }
  }
  return {
    install_method: installMethod,
    mode: 'rpios',
    platform: '',
    server_host: defaultNewFrameServerHost(savedSettings),
  }
}

// A virtual frame is an embedded-mode frame on the "virtual" platform: no
// board, no panel, no pins, no WiFi. The backend renders its scenes (same
// wasm path as the thin clients) and serves them as an image/page URL, and
// ensure_embedded_frame_defaults sets device to "virtual" server-side.
// Mirrors the clamp in backend/app/api/virtual_frame.py
const VIRTUAL_MIN_DIMENSION = 16
const VIRTUAL_MAX_DIMENSION = 4096
const VIRTUAL_DEFAULT_WIDTH = 800
const VIRTUAL_DEFAULT_HEIGHT = 480

function setVirtualInstallValues(savedSettings: FrameOSSettings): Partial<NewFrameFormType> {
  return {
    install_method: 'embedded',
    mode: 'embedded',
    platform: EMBEDDED_VIRTUAL,
    frame_host: '',
    server_host: defaultNewFrameServerHost(savedSettings),
    device: 'virtual',
    device_config: {},
    width: VIRTUAL_DEFAULT_WIDTH,
    height: VIRTUAL_DEFAULT_HEIGHT,
    gpio_buttons: [],
  }
}

const WAVESHARE_13IN3E6_HARDWARE_PRESET: FrameEmbeddedHardwarePreset = 'waveshare_esp32_s3_epaper_13_3e6'
const WAVESHARE_13IN3E6_DEVICE = 'waveshare.EPD_13in3e'
const WAVESHARE_PHOTOPAINTER_HARDWARE_PRESET: FrameEmbeddedHardwarePreset = 'waveshare_esp32_s3_photopainter'
const WAVESHARE_PHOTOPAINTER_DEVICE = 'waveshare.EPD_7in3e'
const WAVESHARE_PHOTOPAINTER_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 12,
  dc: 8,
  cs: 9,
  cs2: -1,
  busy: 13,
  sck: 10,
  mosi: 11,
  pwr: -1,
}
const WAVESHARE_PHOTOPAINTER_GPIO_BUTTONS: GPIOButton[] = [
  { pin: 0, label: 'BOOT' },
  { pin: 4, label: 'KEY1' },
]
const WAVESHARE_13IN3E6_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 2,
  dc: 11,
  cs: 10,
  cs2: 3,
  busy: 12,
  sck: 9,
  mosi: 46,
  pwr: 1,
}
const WAVESHARE_PHOTOPAINTER_SD_CARD_ASSETS: NonNullable<
  NonNullable<NewFrameFormType['device_config']>['sdCardAssets']
> = {
  enabled: true,
  preset: WAVESHARE_PHOTOPAINTER_HARDWARE_PRESET,
  mountPath: '/srv/assets',
  pins: { cs: 38, sck: 39, miso: 40, mosi: 41 },
  maxFrequencyKHz: 20000,
}
const WAVESHARE_13IN3E6_SD_CARD_ASSETS: NonNullable<NonNullable<NewFrameFormType['device_config']>['sdCardAssets']> = {
  enabled: true,
  preset: WAVESHARE_13IN3E6_HARDWARE_PRESET,
  mountPath: '/srv/assets',
  pins: { cs: 15, sck: 6, miso: 5, mosi: 7 },
  maxFrequencyKHz: 20000,
}

// Mirrors EMBEDDED_TRMNL_OG_PINS and friends in backend/app/tasks/embedded_firmware.py
const TRMNL_OG_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 10,
  dc: 5,
  cs: 6,
  cs2: -1,
  busy: 4,
  sck: 7,
  mosi: 8,
  pwr: -1,
}
const XIAO_EPAPER_DRIVER_BOARD_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 38,
  dc: 10,
  cs: 44,
  cs2: -1,
  busy: 4,
  sck: 7,
  mosi: 9,
  pwr: -1,
}
const XTEINK_X4_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 5,
  dc: 4,
  cs: 21,
  cs2: -1,
  busy: 6,
  sck: 8,
  mosi: 10,
  pwr: -1,
}
const SEEED_RETERMINAL_STICKY_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 17,
  dc: 16,
  cs: 15,
  cs2: -1,
  busy: 18,
  sck: 13,
  mosi: 14,
  pwr: -1,
}
const SEEED_RETERMINAL_E10XX_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 12,
  dc: 11,
  cs: 10,
  cs2: -1,
  busy: 13,
  sck: 7,
  mosi: 9,
  pwr: -1,
}
const ELECROW_CROWPANEL_5IN79_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 47,
  dc: 46,
  cs: 45,
  cs2: -1,
  busy: 48,
  sck: 12,
  mosi: 11,
  pwr: -1,
}
// Mirrors EMBEDDED_INKY_FRAME_PINS in backend/app/tasks/embedded_firmware.py.
// All Inky Frame sizes share the carrier wiring; BUSY and the five front
// buttons sit behind a shift register (sr_* keys, busy_bit) that only the
// pico firmware consumes.
const INKY_FRAME_PINS: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']> = {
  rst: 27,
  dc: 28,
  cs: 17,
  cs2: -1,
  busy: -1,
  sck: 18,
  mosi: 19,
  pwr: -1,
  sr_clock: 8,
  sr_latch: 9,
  sr_data: 10,
  busy_bit: 7,
  hold_vsys: 2,
}

interface EmbeddedHardwarePresetConfig {
  label: string
  platform: string
  device: string
  flashSize: NonNullable<NonNullable<NewFrameFormType['embedded']>['flashSize']>
  psramMB: number
  pins: NonNullable<NonNullable<NewFrameFormType['device_config']>['pins']>
  gpioButtons: GPIOButton[]
  sdCardAssets?: NonNullable<NonNullable<NewFrameFormType['device_config']>['sdCardAssets']>
}

// Mirrors EMBEDDED_HARDWARE_PRESETS in backend/app/tasks/embedded_firmware.py
const EMBEDDED_HARDWARE_PRESET_CONFIGS: Partial<Record<FrameEmbeddedHardwarePreset, EmbeddedHardwarePresetConfig>> = {
  [WAVESHARE_PHOTOPAINTER_HARDWARE_PRESET]: {
    label: 'Waveshare ESP32-S3 PhotoPainter',
    platform: EMBEDDED_ESP32_S3,
    device: WAVESHARE_PHOTOPAINTER_DEVICE,
    flashSize: '16MB',
    psramMB: 8,
    pins: WAVESHARE_PHOTOPAINTER_PINS,
    gpioButtons: WAVESHARE_PHOTOPAINTER_GPIO_BUTTONS,
    sdCardAssets: WAVESHARE_PHOTOPAINTER_SD_CARD_ASSETS,
  },
  [WAVESHARE_13IN3E6_HARDWARE_PRESET]: {
    label: 'Waveshare ESP32-S3 ePaper 13.3E6',
    platform: EMBEDDED_ESP32_S3,
    device: WAVESHARE_13IN3E6_DEVICE,
    flashSize: '32MB',
    psramMB: 16,
    pins: WAVESHARE_13IN3E6_PINS,
    gpioButtons: [],
    sdCardAssets: WAVESHARE_13IN3E6_SD_CARD_ASSETS,
  },
  trmnl_og: {
    label: 'TRMNL OG (7.5" ESP32-C3)',
    platform: EMBEDDED_ESP32_C3,
    device: 'waveshare.EPD_7in5_V2',
    flashSize: '4MB',
    psramMB: 0,
    pins: TRMNL_OG_PINS,
    gpioButtons: [{ pin: 2, label: 'BUTTON' }],
  },
  trmnl_bwry: {
    label: 'TRMNL BWRY (7.5" color ESP32-C3)',
    platform: EMBEDDED_ESP32_C3,
    device: 'waveshare.EPD_7in5yr',
    flashSize: '4MB',
    psramMB: 0,
    pins: TRMNL_OG_PINS,
    gpioButtons: [{ pin: 2, label: 'BUTTON' }],
  },
  trmnl_og_diy_kit: {
    label: 'TRMNL 7.5" DIY Kit (XIAO ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_7in5_V2',
    flashSize: '8MB',
    psramMB: 8,
    pins: XIAO_EPAPER_DRIVER_BOARD_PINS,
    gpioButtons: [
      { pin: 0, label: 'BOOT' },
      { pin: 5, label: 'KEY3' },
    ],
  },
  trmnl_4in26_diy_kit: {
    label: 'TRMNL 4.26" DIY Kit (XIAO ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_4in26',
    flashSize: '8MB',
    psramMB: 8,
    pins: XIAO_EPAPER_DRIVER_BOARD_PINS,
    gpioButtons: [
      { pin: 0, label: 'BOOT' },
      { pin: 2, label: 'KEY1' },
    ],
  },
  xteink_x4: {
    label: 'XTEINK X4 (4.26" ESP32-C3)',
    platform: EMBEDDED_ESP32_C3,
    device: 'waveshare.EPD_4in26',
    flashSize: '16MB',
    psramMB: 0,
    pins: XTEINK_X4_PINS,
    gpioButtons: [{ pin: 3, label: 'POWER' }],
  },
  seeed_reterminal_sticky: {
    label: 'Seeed reTerminal Sticky (3.97" ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_3in97',
    flashSize: '32MB',
    psramMB: 8,
    pins: SEEED_RETERMINAL_STICKY_PINS,
    gpioButtons: [{ pin: 4, label: 'POWER' }],
  },
  seeed_reterminal_e1001: {
    label: 'Seeed reTerminal E1001 (7.5" ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_7in5_V2',
    flashSize: '32MB',
    psramMB: 8,
    pins: SEEED_RETERMINAL_E10XX_PINS,
    gpioButtons: [
      { pin: 3, label: 'REFRESH' },
      { pin: 4, label: 'LEFT' },
      { pin: 5, label: 'RIGHT' },
    ],
  },
  seeed_reterminal_e1002: {
    label: 'Seeed reTerminal E1002 (7.3" color ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_7in3e',
    flashSize: '32MB',
    psramMB: 8,
    pins: SEEED_RETERMINAL_E10XX_PINS,
    gpioButtons: [
      { pin: 3, label: 'REFRESH' },
      { pin: 4, label: 'LEFT' },
      { pin: 5, label: 'RIGHT' },
    ],
  },
  elecrow_crowpanel_5in79: {
    label: 'Elecrow CrowPanel 5.79" (ESP32-S3)',
    platform: EMBEDDED_ESP32_S3,
    device: 'waveshare.EPD_5in79',
    flashSize: '8MB',
    psramMB: 8,
    pins: ELECROW_CROWPANEL_5IN79_PINS,
    gpioButtons: [
      { pin: 2, label: 'HOME' },
      { pin: 1, label: 'EXIT' },
      { pin: 4, label: 'NEXT' },
      { pin: 5, label: 'OK' },
      { pin: 6, label: 'PREV' },
    ],
  },
  // Pimoroni Inky Frame family: pico platforms flash a generic UF2 over
  // BOOTSEL and are provisioned via USB serial — no backend firmware builds.
  // Buttons A-E live behind the shift register, so gpioButtons stays empty.
  pimoroni_inky_frame_4: {
    label: 'Pimoroni Inky Frame 4.0" (Pico W)',
    platform: EMBEDDED_PICO_W,
    device: 'waveshare.EPD_4in01f',
    flashSize: '2MB',
    psramMB: 0,
    pins: INKY_FRAME_PINS,
    gpioButtons: [],
  },
  pimoroni_inky_frame_5_7: {
    label: 'Pimoroni Inky Frame 5.7" (Pico W)',
    platform: EMBEDDED_PICO_W,
    device: 'waveshare.EPD_5in65f',
    flashSize: '2MB',
    psramMB: 0,
    pins: INKY_FRAME_PINS,
    gpioButtons: [],
  },
  pimoroni_inky_frame_7_3: {
    label: 'Pimoroni Inky Frame 7.3" (Pico W)',
    platform: EMBEDDED_PICO_W,
    device: 'waveshare.EPD_7in3f',
    flashSize: '2MB',
    psramMB: 0,
    pins: INKY_FRAME_PINS,
    gpioButtons: [],
  },
  pimoroni_inky_frame_7_3_pico2: {
    label: 'Pimoroni Inky Frame 7.3" (Pico 2 W, 2024)',
    platform: EMBEDDED_PICO_2W,
    device: 'waveshare.EPD_7in3f',
    flashSize: '4MB',
    psramMB: 0,
    pins: INKY_FRAME_PINS,
    gpioButtons: [],
  },
  pimoroni_inky_frame_7_3_spectra: {
    label: 'Pimoroni Inky Frame 7.3" Spectra 6 (Pico 2 W)',
    platform: EMBEDDED_PICO_2W,
    device: 'waveshare.EPD_7in3e',
    flashSize: '4MB',
    psramMB: 0,
    pins: INKY_FRAME_PINS,
    gpioButtons: [],
  },
}

function normalizeEmbeddedHardwarePreset(value: unknown): FrameEmbeddedHardwarePreset {
  if (typeof value === 'string' && value in EMBEDDED_HARDWARE_PRESET_CONFIGS) {
    return value as FrameEmbeddedHardwarePreset
  }
  return 'custom'
}

function embeddedHardwarePresetConfig(
  hardwarePreset: FrameEmbeddedHardwarePreset
): EmbeddedHardwarePresetConfig | null {
  const config = EMBEDDED_HARDWARE_PRESET_CONFIGS[hardwarePreset]
  if (!config) {
    return null
  }
  return {
    ...config,
    pins: { ...config.pins },
    gpioButtons: config.gpioButtons.map((button) => ({ ...button })),
    sdCardAssets: config.sdCardAssets ? { ...config.sdCardAssets, pins: { ...config.sdCardAssets.pins } } : undefined,
  }
}

function renderDeviceOptions(): JSX.Element[] {
  return devices.map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.options.map((device) => (
        <option key={device.value} value={device.value}>
          {device.label}
        </option>
      ))}
    </optgroup>
  ))
}

const unsupportedEmbeddedWaveshareDevices = new Set([
  'waveshare.EPD_10in3',
  'waveshare.EPD_12in48',
  'waveshare.EPD_12in48b',
  'waveshare.EPD_12in48b_V2',
])

const embeddedDevices = [
  // Device "none" is what survives the backend's embedded defaults and maps
  // to firmware panel "none" (headless). "web_only" would NOT: the backend
  // rewrites an empty or web_only device to the default Waveshare panel
  // (ensure_embedded_frame_defaults in backend/app/tasks/embedded_firmware.py).
  { value: 'none', label: 'No display panel' },
  ...(devices
    .find((group) => group.label === 'Waveshare')
    ?.options.filter((device) => !unsupportedEmbeddedWaveshareDevices.has(device.value)) ?? []),
]

function renderEmbeddedDeviceOptions(): JSX.Element[] {
  return embeddedDevices.map((device) => (
    <option key={device.value} value={device.value}>
      {device.label}
    </option>
  ))
}

function renderPlatformOptions(installMethod: FrameInstallMethod): JSX.Element[] {
  const platforms =
    installMethod === 'sd_card' ? buildrootPlatforms : installMethod === 'embedded' ? embeddedPlatforms : rpiOSPlatforms
  return platforms.map((platform) => (
    <option key={platform.value} value={platform.value}>
      {platform.label}
    </option>
  ))
}

// 'virtual' is not its own install_method: it is the embedded install flow on
// the "virtual" platform, surfaced as a separate card because there is no
// hardware to flash and none of the ESP32 steps apply.
type AddFrameMode = FrameInstallMethod | 'import' | 'virtual'
type UploadHeader = { name: string; value: string }

function installMethodTitle(installMethod: AddFrameMode): string {
  if (installMethod === 'sd_card') {
    return 'Download SD card'
  }
  if (installMethod === 'script') {
    return 'Install with a script'
  }
  if (installMethod === 'embedded') {
    return 'Flash embedded device'
  }
  if (installMethod === 'virtual') {
    return 'Virtual frame'
  }
  if (installMethod === 'import') {
    return 'Import frame'
  }
  return 'Install over SSH'
}

function AddFrameSubmitButton({ loading }: { loading: boolean }): JSX.Element {
  return (
    <button
      type="submit"
      disabled={loading}
      className="frameos-primary-action flex h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {loading ? <Spinner color="white" /> : null}
      Add frame
    </button>
  )
}

function renderNewFrameDriverConfig(
  newFrame: NewFrameFormType,
  setNewFrameValue: (key: any, value: any) => void
): JSX.Element | null {
  const deviceConfig = newFrame.device_config ?? {}
  const setDeviceConfig = (nextDeviceConfig: NonNullable<NewFrameFormType['device_config']>) => {
    setNewFrameValue('device_config', nextDeviceConfig)
  }

  if (newFrame.device === 'waveshare.EPD_10in3') {
    return (
      <FormField label="VCOM">
        <input
          className={textInputClassName()}
          value={deviceConfig.vcom ?? ''}
          onChange={(event) => setDeviceConfig({ ...deviceConfig, vcom: event.target.value })}
          placeholder="-1.48"
          required
        />
      </FormField>
    )
  }

  if (partialRefreshDevices.has(newFrame.device ?? '')) {
    return (
      <PartialRefreshSettingsFields
        value={deviceConfig}
        onChange={setDeviceConfig}
        variant="stacked"
        panelDefaults={partialRefreshDefaultsByDevice[newFrame.device ?? '']}
        numberInputClassName={textInputClassName()}
      />
    )
  }

  if (newFrame.device === 'http.upload') {
    const headers: UploadHeader[] = Array.isArray(deviceConfig.uploadHeaders)
      ? deviceConfig.uploadHeaders.map((header) => ({ name: header?.name ?? '', value: header?.value ?? '' }))
      : []
    const updateHeader = (index: number, key: 'name' | 'value', newValue: string) => {
      setDeviceConfig({
        ...deviceConfig,
        uploadHeaders: headers.map((header: UploadHeader, idx: number) =>
          idx === index ? { name: header?.name ?? '', value: header?.value ?? '', [key]: newValue } : header
        ),
      })
    }
    const addHeader = () => {
      setDeviceConfig({ ...deviceConfig, uploadHeaders: [...headers, { name: '', value: '' }] })
    }
    const removeHeader = (index: number) => {
      setDeviceConfig({
        ...deviceConfig,
        uploadHeaders: headers.filter((_: UploadHeader, idx: number) => idx !== index),
      })
    }

    return (
      <>
        <FormField label="Upload URL">
          <input
            className={textInputClassName()}
            value={deviceConfig.uploadUrl ?? ''}
            onChange={(event) => setDeviceConfig({ ...deviceConfig, uploadUrl: event.target.value })}
            placeholder="https://example.com/upload"
            required
          />
        </FormField>
        <FormField label="HTTP headers">
          <div className="space-y-2">
            {headers.map((header: UploadHeader, index: number) => (
              <div key={index} className="grid grid-cols-1 gap-2 @md:grid-cols-[1fr_1fr_auto]">
                <input
                  className={textInputClassName()}
                  value={header?.name ?? ''}
                  onChange={(event) => updateHeader(index, 'name', event.target.value)}
                  placeholder="Header name"
                />
                <input
                  className={textInputClassName()}
                  value={header?.value ?? ''}
                  onChange={(event) => updateHeader(index, 'value', event.target.value)}
                  placeholder="Header value"
                />
                <button
                  type="button"
                  onClick={() => removeHeader(index)}
                  className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addHeader}
              className="frameos-secondary-button h-10 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Add header
            </button>
          </div>
        </FormField>
      </>
    )
  }

  return null
}

export function NewFrame({ headerAction }: { headerAction?: JSX.Element }): JSX.Element {
  const { hideForm, importFrame, resetNewFrame, setFile, setNewFrameValue, setNewFrameValues } =
    useActions(newFrameForm)
  const { file, importingFrameLoading, isNewFrameSubmitting, newFrame, newFrameErrors } = useValues(newFrameForm)
  const { savedSettings } = useValues(settingsLogic)
  const installMethod = newFrame.install_method
  const isVirtualPlatform = installMethod === 'embedded' && newFrame.platform === EMBEDDED_VIRTUAL
  const addFrameMode: AddFrameMode | undefined =
    newFrame.mode === 'import' ? 'import' : isVirtualPlatform ? 'virtual' : installMethod
  const timezone = normalizedTimezone(newFrame.timezone, savedSettings.defaults?.timezone)
  const sshKeyOptions = normalizeSshKeys(savedSettings.ssh_keys).keys
  const selectedSshKeys = new Set(newFrame.ssh_keys ?? defaultInstallSshKeyIds(savedSettings))
  const rootPassword = newFrame.ssh_pass ?? ''
  // Each form states its own default rather than inferring it from the form
  // value: install_method is not guaranteed to be populated on every route
  // into this screen, and inferring it wrong silently offers the user the
  // opposite transport from the one the install method needs.
  const remoteControlFor = (method: FrameInstallMethod): boolean =>
    newFrame.agent?.agentEnabled ?? defaultRemoteControl(method)
  const setRemoteControl = (enabled: boolean): void => {
    setNewFrameValue('agent', {
      ...(newFrame.agent ?? {}),
      agentEnabled: enabled,
      agentRunCommands: enabled,
      deployWithAgent: enabled,
    })
  }
  const embeddedHardwarePreset = normalizeEmbeddedHardwarePreset(
    newFrame.embedded?.hardwarePreset ?? newFrame.device_config?.hardwarePreset
  )

  const setEmbeddedHardwarePreset = (hardwarePreset: FrameEmbeddedHardwarePreset): void => {
    if (hardwarePreset === 'custom') {
      setNewFrameValues({
        embedded: { ...(newFrame.embedded ?? {}), hardwarePreset: 'custom' },
        device_config: { ...(newFrame.device_config ?? {}), hardwarePreset: 'custom' },
      })
      return
    }
    const presetConfig = embeddedHardwarePresetConfig(hardwarePreset)
    if (!presetConfig) {
      return
    }

    setNewFrameValues({
      platform: presetConfig.platform,
      device: presetConfig.device,
      embedded: {
        ...(newFrame.embedded ?? {}),
        platform: presetConfig.platform,
        flashSize: presetConfig.flashSize,
        hardwarePreset,
      },
      device_config: {
        ...(newFrame.device_config ?? {}),
        hardwarePreset,
        psramMB: presetConfig.psramMB,
        pins: { ...presetConfig.pins },
        sdCardAssets: presetConfig.sdCardAssets,
      },
      gpio_buttons: presetConfig.gpioButtons.map((button) => ({ ...button })),
    })
  }

  // Virtual frames have no board, panel, pins, or WiFi: the backend renders
  // them and serves the result as an image/page URL. Picking the platform
  // wires in the "virtual" device (the backend would default it the same
  // way) and flips the form to the virtual flow; leaving it resets the
  // device to headless ("none") so the panel picker starts at no panel.
  const setEmbeddedPlatform = (platform: string): void => {
    if (platform === EMBEDDED_VIRTUAL) {
      setNewFrameValues({
        platform,
        device: 'virtual',
        embedded: { ...(newFrame.embedded ?? {}), platform, hardwarePreset: 'custom' },
        device_config: { ...(newFrame.device_config ?? {}), hardwarePreset: 'custom' },
        gpio_buttons: [],
      })
      return
    }
    if (newFrame.device === 'virtual') {
      setNewFrameValues({
        platform,
        device: 'none',
        embedded: { ...(newFrame.embedded ?? {}), platform },
      })
      return
    }
    setNewFrameValues({
      platform,
      embedded: { ...(newFrame.embedded ?? {}), platform },
    })
  }

  const setEmbeddedDevice = (device: string): void => {
    const presetConfig = embeddedHardwarePresetConfig(embeddedHardwarePreset)
    if (presetConfig && device !== presetConfig.device) {
      setNewFrameValues({
        device,
        embedded: { ...(newFrame.embedded ?? {}), hardwarePreset: 'custom' },
        device_config: { ...(newFrame.device_config ?? {}), hardwarePreset: 'custom' },
      })
    } else {
      setNewFrameValue('device', device)
    }
  }

  const cancel = () => {
    setFile(null)
    resetNewFrame()
    hideForm()
  }

  const backToInstallMethods = () => {
    setFile(null)
    setNewFrameValues({ install_method: undefined, mode: 'rpios' })
  }

  return (
    <div className="frameos-form-surface space-y-5 text-slate-900">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">Add frame</div>
          <h2 className="frameos-strong mt-1 text-2xl font-bold tracking-normal text-slate-950">
            {addFrameMode ? installMethodTitle(addFrameMode) : 'FrameOS'}
          </h2>
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>

      {!addFrameMode ? (
        <div className="space-y-2">
          <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
            Installation method
          </div>
          <div className="grid grid-cols-1 gap-2">
            <ModeButton
              onClick={() => setNewFrameValues(setInstallMethodValues('sd_card', savedSettings))}
              title="Download SD card"
              description="Build a flashable Buildroot image."
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
            </ModeButton>
            <ModeButton
              onClick={() => setNewFrameValues(setInstallMethodValues('ssh', savedSettings))}
              title="Install over SSH"
              description="Deploy to a reachable Raspberry Pi OS host."
            >
              <ServerStackIcon className="h-4 w-4" />
            </ModeButton>
            <ModeButton
              onClick={() => setNewFrameValues(setInstallMethodValues('script', savedSettings))}
              title="Install with a script"
              description="Run one command on the device."
            >
              <CommandLineIcon className="h-4 w-4" />
            </ModeButton>
            <ModeButton
              onClick={() => setNewFrameValues(setInstallMethodValues('embedded', savedSettings))}
              title="Flash embedded device"
              description="ESP32-S3/C3 boards and e-ink devices like the TRMNL, XTEINK X4, Inky Frame (Pico W), reTerminal, and CrowPanel."
            >
              <CpuChipIcon className="h-4 w-4" />
            </ModeButton>
            <ModeButton
              onClick={() => setNewFrameValues(setVirtualInstallValues(savedSettings))}
              title="Virtual frame"
              description="No hardware — the backend renders to a PNG anyone can download."
            >
              <ComputerDesktopIcon className="h-4 w-4" />
            </ModeButton>
            <ModeButton
              onClick={() => setNewFrameValues({ mode: 'import', install_method: undefined })}
              title="Import frame"
              description="Load a previously exported frame JSON file."
            >
              <ArrowUpTrayIcon className="h-4 w-4" />
            </ModeButton>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={backToInstallMethods}
            className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back
          </button>
        </div>
      )}

      {addFrameMode === 'ssh' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Use SSH when the backend can directly reach the frame on your network. Set SSH keys in{' '}
            <a className="font-semibold text-[var(--frameos-primary)] hover:underline" href={urls.settings()}>
              global settings
            </a>
            .
          </p>
          <FormField label="Name" error={newFrameErrors.name}>
            <input
              className={textInputClassName()}
              value={newFrame.name ?? ''}
              onChange={(event) => setNewFrameValue('name', event.target.value)}
              placeholder="Kitchen Frame"
              required
            />
          </FormField>
          <FormField label="SSH connection string" error={newFrameErrors.frame_host}>
            <input
              className={textInputClassName()}
              value={newFrame.frame_host ?? ''}
              onChange={(event) => setNewFrameValue('frame_host', event.target.value)}
              placeholder="user:pass@127.0.0.1"
              required
            />
          </FormField>
          <FormField
            label="Backend IP or hostname for reverse access"
            hint={
              isLocalServer(newFrame.server_host) ? (
                <span>
                  <span className="font-semibold text-amber-600">Warning:</span> use this server's real host/IP, not
                  localhost. The frame needs to connect back to it.
                </span>
              ) : null
            }
          >
            <input
              className={textInputClassName()}
              value={newFrame.server_host ?? ''}
              onChange={(event) => setNewFrameValue('server_host', event.target.value)}
              placeholder="127.0.0.1"
              required
            />
          </FormField>
          <FormField label="Platform" error={newFrameErrors.platform}>
            <select
              className={selectClassName()}
              value={newFrame.platform ?? ''}
              onChange={(event) => setNewFrameValue('platform', event.target.value)}
            >
              {renderPlatformOptions('ssh')}
            </select>
          </FormField>
          <FormField label="Display driver">
            <select
              className={selectClassName()}
              value={newFrame.device ?? 'web_only'}
              onChange={(event) => setNewFrameValue('device', event.target.value)}
            >
              {renderDeviceOptions()}
            </select>
          </FormField>
          {renderNewFrameDriverConfig(newFrame, setNewFrameValue)}
          <RemoteControlField enabled={remoteControlFor('ssh')} onChange={setRemoteControl} />
          <div className="flex gap-2 pt-2">
            <AddFrameSubmitButton loading={isNewFrameSubmitting} />
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </Form>
      ) : addFrameMode === 'script' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Use this when SSH is not available. You'll get a command that installs FrameOS, starts FrameOS Remote, and
            connects back to this backend.
          </p>
          <FormField label="Name" error={newFrameErrors.name}>
            <input
              className={textInputClassName()}
              value={newFrame.name ?? ''}
              onChange={(event) => setNewFrameValue('name', event.target.value)}
              placeholder="Kitchen Frame"
              required
            />
          </FormField>
          <FormField
            label="Backend IP or hostname for reverse access"
            hint={
              isLocalServer(newFrame.server_host) ? (
                <span>
                  <span className="font-semibold text-amber-600">Warning:</span> use this server's real host/IP, not
                  localhost.
                </span>
              ) : null
            }
          >
            <input
              className={textInputClassName()}
              value={newFrame.server_host ?? ''}
              onChange={(event) => setNewFrameValue('server_host', event.target.value)}
              placeholder="127.0.0.1"
              required
            />
          </FormField>
          <FormField label="Platform" error={newFrameErrors.platform}>
            <select
              className={selectClassName()}
              value={newFrame.platform ?? ''}
              onChange={(event) => setNewFrameValue('platform', event.target.value)}
            >
              {renderPlatformOptions('script')}
            </select>
          </FormField>
          <FormField label="Display driver">
            <select
              className={selectClassName()}
              value={newFrame.device ?? 'web_only'}
              onChange={(event) => setNewFrameValue('device', event.target.value)}
            >
              {renderDeviceOptions()}
            </select>
          </FormField>
          {renderNewFrameDriverConfig(newFrame, setNewFrameValue)}
          <div className="flex gap-2 pt-2">
            <AddFrameSubmitButton loading={isNewFrameSubmitting} />
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </Form>
      ) : addFrameMode === 'sd_card' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Buildroot bundles FrameOS into a dedicated firmware image that you can flash to an SD card.
          </p>
          <FormField label="Name" error={newFrameErrors.name}>
            <input
              className={textInputClassName()}
              value={newFrame.name ?? ''}
              onChange={(event) => setNewFrameValue('name', event.target.value)}
              placeholder="Kitchen Frame"
              required
            />
          </FormField>
          <FormField
            label="Backend IP or hostname for reverse access"
            hint={
              isLocalServer(newFrame.server_host) ? (
                <span>
                  <span className="font-semibold text-amber-600">Warning:</span> use this server's real host/IP, not
                  localhost.
                </span>
              ) : null
            }
          >
            <input
              className={textInputClassName()}
              value={newFrame.server_host ?? ''}
              onChange={(event) => setNewFrameValue('server_host', event.target.value)}
              placeholder="127.0.0.1"
              required
            />
          </FormField>
          <FormField label="Platform" error={newFrameErrors.platform}>
            <select
              className={selectClassName()}
              value={newFrame.platform ?? ''}
              onChange={(event) => setNewFrameValue('platform', event.target.value)}
            >
              {renderPlatformOptions('sd_card')}
            </select>
          </FormField>
          <FormField label="Timezone">
            <select
              className={selectClassName()}
              value={timezone}
              onChange={(event) => setNewFrameValue('timezone', event.target.value)}
            >
              {timezoneOptions.map((timezone) => (
                <option key={timezone.value} value={timezone.value}>
                  {timezone.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Driver">
            <select
              className={selectClassName()}
              value={newFrame.device ?? 'web_only'}
              onChange={(event) => setNewFrameValue('device', event.target.value)}
            >
              {renderDeviceOptions()}
            </select>
          </FormField>
          {renderNewFrameDriverConfig(newFrame, setNewFrameValue)}
          <FormField
            label={
              <span>
                Root password
                {!rootPassword ? <span className="ml-1 text-red-500">- Empty password is unsafe</span> : null}
              </span>
            }
          >
            <input
              className={textInputClassName()}
              value={rootPassword}
              onChange={(event) => setNewFrameValue('ssh_pass', event.target.value)}
              placeholder="Root password"
              type="password"
              autoComplete="new-password"
            />
          </FormField>
          <div className="space-y-2">
            <div className="frameos-form-label text-sm font-semibold text-slate-700">SSH keys</div>
            {sshKeyOptions.length === 0 ? (
              <div className="frameos-form-hint text-sm text-slate-500">No SSH keys configured in settings.</div>
            ) : (
              <div className="space-y-2 frame-tool-panel">
                {sshKeyOptions.map((key) => (
                  <div key={key.id} className="flex min-w-0 items-center gap-2">
                    <Switch
                      value={selectedSshKeys.has(key.id)}
                      onChange={(value) => {
                        const next = new Set(selectedSshKeys)
                        if (value) {
                          next.add(key.id)
                        } else {
                          next.delete(key.id)
                        }
                        setNewFrameValue('ssh_keys', Array.from(next))
                      }}
                    />
                    <div className="min-w-0 flex-1 truncate text-sm text-slate-700">{key.name || key.id}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <RemoteControlField enabled={remoteControlFor('sd_card')} onChange={setRemoteControl} />

          <FormField label="WiFi network" error={newFrameErrors.network?.wifiSSID}>
            <input
              className={textInputClassName()}
              value={newFrame.network?.wifiSSID ?? ''}
              onChange={(event) =>
                setNewFrameValue('network', { ...(newFrame.network ?? {}), wifiSSID: event.target.value })
              }
              placeholder="Home WiFi"
              autoComplete="off"
            />
          </FormField>
          <FormField label="WiFi password" error={newFrameErrors.network?.wifiPassword}>
            <input
              className={textInputClassName()}
              value={newFrame.network?.wifiPassword ?? ''}
              onChange={(event) =>
                setNewFrameValue('network', { ...(newFrame.network ?? {}), wifiPassword: event.target.value })
              }
              placeholder="Network password"
              type="password"
              autoComplete="new-password"
            />
          </FormField>
          <Field name="rememberWifi">
            <Checkbox label="Remember wifi details for next time" />
          </Field>
          <div className="flex gap-2 pt-2">
            <AddFrameSubmitButton loading={isNewFrameSubmitting} />
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </Form>
      ) : addFrameMode === 'virtual' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            No hardware — the backend renders this frame's scenes and serves them as an image URL (one PNG per request)
            and a self-refreshing kiosk page for browsers, tablets, and signage players. Both URLs appear in the frame's
            settings after it is added.
          </p>
          <FormField label="Name" error={newFrameErrors.name}>
            <input
              className={textInputClassName()}
              value={newFrame.name ?? ''}
              onChange={(event) => setNewFrameValue('name', event.target.value)}
              placeholder="Kitchen Frame"
              required
            />
          </FormField>
          <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
            <FormField label="Width">
              <input
                className={textInputClassName()}
                type="number"
                min={VIRTUAL_MIN_DIMENSION}
                max={VIRTUAL_MAX_DIMENSION}
                value={newFrame.width ?? ''}
                onChange={(event) => {
                  const parsed = parseInt(event.target.value, 10)
                  setNewFrameValue('width', Number.isNaN(parsed) ? undefined : parsed)
                }}
                placeholder={String(VIRTUAL_DEFAULT_WIDTH)}
                required
              />
            </FormField>
            <FormField label="Height">
              <input
                className={textInputClassName()}
                type="number"
                min={VIRTUAL_MIN_DIMENSION}
                max={VIRTUAL_MAX_DIMENSION}
                value={newFrame.height ?? ''}
                onChange={(event) => {
                  const parsed = parseInt(event.target.value, 10)
                  setNewFrameValue('height', Number.isNaN(parsed) ? undefined : parsed)
                }}
                placeholder={String(VIRTUAL_DEFAULT_HEIGHT)}
                required
              />
            </FormField>
          </div>
          <FormField label="Color mode">
            <select
              className={selectClassName()}
              value={newFrame.device_config?.colorMode ?? 'rgb'}
              onChange={(event) =>
                setNewFrameValue('device_config', {
                  ...(newFrame.device_config ?? {}),
                  colorMode: event.target.value as FrameVirtualColorMode,
                })
              }
            >
              {virtualColorModes.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </FormField>
          <div className="flex gap-2 pt-2">
            <AddFrameSubmitButton loading={isNewFrameSubmitting} />
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </Form>
      ) : addFrameMode === 'embedded' ? (
        <Form logic={newFrameForm} formKey="newFrame" className="space-y-4" enableFormOnSubmit>
          <p className="frameos-form-hint text-sm leading-relaxed text-slate-500">
            Build a firmware image for an ESP32 microcontroller and flash it over USB serial or from the browser. The
            firmware renders scenes on-device, drives SPI e-ink panels, and updates itself over the air.
          </p>
          <FormField label="Name" error={newFrameErrors.name}>
            <input
              className={textInputClassName()}
              value={newFrame.name ?? ''}
              onChange={(event) => setNewFrameValue('name', event.target.value)}
              placeholder="Kitchen Frame"
              required
            />
          </FormField>
          <FormField label="Platform" error={newFrameErrors.platform}>
            <select
              className={selectClassName()}
              value={newFrame.platform ?? ''}
              onChange={(event) => setEmbeddedPlatform(event.target.value)}
            >
              {renderPlatformOptions('embedded')}
            </select>
          </FormField>
          <FormField label="Hardware preset">
            <select
              className={selectClassName()}
              value={embeddedHardwarePreset}
              onChange={(event) => setEmbeddedHardwarePreset(normalizeEmbeddedHardwarePreset(event.target.value))}
            >
              <option value="custom">Custom ESP32 board</option>
              {Object.entries(EMBEDDED_HARDWARE_PRESET_CONFIGS).map(([preset, config]) => (
                <option key={preset} value={preset}>
                  {isThinClientEmbeddedPlatform(config.platform) ? `${config.label} — Thin client` : config.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Display panel" error={newFrameErrors.device}>
            <select
              className={selectClassName()}
              value={newFrame.device || 'none'}
              onChange={(event) => setEmbeddedDevice(event.target.value)}
              required
            >
              {renderEmbeddedDeviceOptions()}
            </select>
          </FormField>
          {renderNewFrameDriverConfig(newFrame, setNewFrameValue)}
          <FormField label="WiFi network" error={newFrameErrors.network?.wifiSSID}>
            <input
              className={textInputClassName()}
              value={newFrame.network?.wifiSSID ?? ''}
              onChange={(event) =>
                setNewFrameValue('network', { ...(newFrame.network ?? {}), wifiSSID: event.target.value })
              }
              placeholder="Home WiFi"
              autoComplete="off"
            />
          </FormField>
          <FormField label="WiFi password" error={newFrameErrors.network?.wifiPassword}>
            <input
              className={textInputClassName()}
              value={newFrame.network?.wifiPassword ?? ''}
              onChange={(event) =>
                setNewFrameValue('network', { ...(newFrame.network ?? {}), wifiPassword: event.target.value })
              }
              placeholder="Network password"
              type="password"
              autoComplete="new-password"
            />
          </FormField>
          <Field name="rememberWifi">
            <Checkbox label="Remember wifi details for next time" />
          </Field>
          <div className="flex gap-2 pt-2">
            <AddFrameSubmitButton loading={isNewFrameSubmitting} />
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </Form>
      ) : addFrameMode === 'import' ? (
        <div className="space-y-4">
          <label className="frameos-import-target flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center transition hover:bg-slate-100">
            <ArrowUpTrayIcon className="mb-2 h-8 w-8 text-slate-400" />
            <span className="frameos-strong text-sm font-semibold text-slate-800">
              {file ? file.name : 'Choose frame JSON'}
            </span>
            <span className="frameos-muted mt-1 text-xs text-slate-500">Import a previously exported frame.</span>
            <input
              type="file"
              accept=".json"
              className="sr-only"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={importFrame}
              disabled={!file || importingFrameLoading}
              className="frameos-primary-action flex h-11 flex-1 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {importingFrameLoading ? <Spinner color="white" /> : 'Import'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="frameos-secondary-button h-11 rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
