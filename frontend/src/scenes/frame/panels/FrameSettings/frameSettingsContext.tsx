import { createContext, useContext, type ReactNode } from 'react'
import { useActions, useValues } from 'kea'
import equal from 'fast-deep-equal'
import { frameAdminLoginIsOnlyAccess } from '../../frameDeployUtils'
import { framesModel } from '../../../../models/framesModel'
import { DEFAULT_FRAME_ERROR_BEHAVIOR, frameLogic, normalizeFrameErrorBehavior } from '../../frameLogic'
import { frameAdminUrl, frameControlUrl, frameImageUrl, frameUrl } from '../../../../decorators/frame'
import { EMBEDDED_VIRTUAL, withCustomPalette } from '../../../../devices'
import { paletteDeviceOf } from '../../../../utils/assetColors/devicePalette'
import {
  cloudFrameSupportsEsp32BatteryEnablePin,
  cloudFrameSupportsEsp32Buzzer,
  cloudFrameSupportsEsp32VoiceChat,
  cloudFrameSupportsEsp32Led,
  cloudFrameSupportsEsp32ExtendedSettings,
  cloudFrameSupportsEsp32TimeZone,
  cloudFrameSupportsExtendedSettings,
  cloudFrameSupportsHardwareSettings,
  cloudFrameSupportsDisplayDriverSetting,
  esp32BatteryEnablePinCloudFrameSettingsMinVersion,
  esp32BuzzerCloudFrameSettingsMinVersion,
  esp32VoiceChatCloudFrameSettingsMinVersion,
  esp32LedCloudFrameSettingsMinVersion,
} from '../../../../utils/cloudFrameApi'
import { appsLogic } from '../Apps/appsLogic'
import { logsLogic } from '../Logs/logsLogic'
import { frameSettingsLogic } from './frameSettingsLogic'
import { workspaceLogic } from '../../../workspace/workspaceLogic'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'
import { frameSettingsSectionIsAllowed, workspaceMode, type WorkspaceMode } from '../../../workspace/workspaceSurfaces'
import { timezoneOptions } from '../../../../decorators/timezones'
import type { DeepPartial } from 'kea-forms'
import type { PowerSettingsValues } from '../../../../components/PowerSettingsFields'
import type {
  FrameEmbeddedHardwarePreset,
  FrameErrorBehaviorMode,
  FrameType,
  GPIOButton,
  Palette,
} from '../../../../types'
import type { Option } from '../../../../components/Select'
import {
  DEFAULT_MAX_HTTP_RESPONSE_BYTES,
  EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES,
  configuredGpioButtonsForDevice,
  esp32HardwarePresetConfig,
  normalizeEsp32HardwarePreset,
} from './esp32Hardware'
import {
  embeddedPowerProfileFor,
  frameSettingsSurfaceFor,
  type EmbeddedPowerProfile,
  type FrameSettingsSurface,
} from './frameSettingsSurface'
import { newMountpoint } from './frameSettingsHelpers'
import {
  boardMicrophonePins,
  configuredMicrophonePinsOf,
  deviceConfigWithVoicePermission,
  effectiveMicrophonePins,
  microphonePinsNameOne,
  voicePermissionsFromDeviceConfig,
  voicePermissionsOf,
  type VoicePermissionKey,
  type VoicePermissions,
} from '../../../../utils/voiceChat'

export interface FrameSettingsProps {
  className?: string
  hideDropdown?: boolean
  hideDeploymentMode?: boolean
  scrollContainer?: boolean
}

export interface FrameErrorBehaviorModeOption {
  value: FrameErrorBehaviorMode
  title: string
  description: string
}

/**
 * Everything the Settings sections read, derived once.
 *
 * The sections under `sections/` are otherwise free of kea: they take this
 * object and render. That is deliberate — the old single component derived
 * ninety values at the top and then referred to them two thousand lines
 * further down, which is why nobody could tell which surface saw what.
 *
 * Surface gating is NOT in here: it lives in frameSettingsSurface.ts and is
 * applied by <FrameSettingsSection>. What this object carries are the
 * per-frame and per-firmware conditions a section still has to decide for
 * itself (which panel is attached, what version the device reported).
 */
/** How a status LED is lit (the contract's `led_type` enum). */
export type StatusLedType = 'gpio' | 'gpio_inverted' | 'ws2812'

export interface FrameSettingsContextValue extends FrameSettingsProps {
  /** Which of the four surfaces this panel is being rendered on. */
  surface: FrameSettingsSurface
  /** The workspace plane. `surface` splits `cloud` into Linux and ESP32. */
  workspaceSurfaceMode: WorkspaceMode
  inFrameAdminMode: boolean

  frameId: FrameType['id']
  frame: FrameType
  frameForm: Partial<FrameType>
  frameFormTouches: Record<string, boolean>
  /** The frame's deployment mode: 'rpios' | 'buildroot' | 'embedded'. */
  mode: string
  isBuildrootMode: boolean
  isEmbeddedMode: boolean
  isVirtualPlatform: boolean

  setFrameFormValues: (values: DeepPartial<FrameType>) => void
  touchFrameFormField: (key: string) => void
  updateDeployedSshKeys: () => void
  forgetSshHostKey: () => void
  generateFrameAdminCredentials: () => void
  generateTlsCertificates: () => void
  verifyTlsCertificates: () => void
  openLogs: () => void

  // Cloud firmware floors. Each batch is refused WHOLE by a device that does
  // not know one of its keys, so below a floor the fields render disabled with
  // the reason rather than disappearing.
  cloudExtendedSettingsSupported: boolean
  cloudHardwareSettingsSupported: boolean
  /** Can this cloud frame be sent a new display driver (`device`)? */
  cloudDisplayDriverSupported: boolean
  cloudEsp32ExtendedSettingsSupported: boolean
  cloudEsp32TimeZoneSupported: boolean
  cloudBatteryEnablePinDisabledReason: string | undefined

  /** The panel this frame drives: the device reported it on the cloud, the form holds it elsewhere. */
  paletteDevice: string
  palette: Palette | undefined
  /** A fixed button map for boards whose buttons are wired on the board itself. */
  configuredGpioButtons: GPIOButton[] | null
  /**
   * The button map the device reported running with (`hardware.gpioButtons`,
   * cloud frames on 2026.10.7+ firmware). Null where the report has none,
   * so the section falls back to the editable list.
   */
  reportedGpioButtons: GPIOButton[] | null
  /**
   * ESP32 only, null elsewhere: the buzzer a GPIO button press sounds and
   * its pitch (fos_buzzer.c). The cloud pushes `buzzer_pin` /
   * `buzzer_tone_hz`; the backend keeps `buzzerPin` / `buzzerToneHz` in
   * device_config for the device's settings poll. `reported*` is what a
   * cloud frame said it runs with (`hardware.buzzerPin` / `buzzerToneHz`);
   * `disabledReason` the cloud firmware floor.
   */
  buttonBeep: {
    pin: number | undefined
    toneHz: number | undefined
    reportedPin: number | undefined
    reportedToneHz: number | undefined
    disabledReason: string | undefined
  } | null
  setButtonBeep: (patch: { pin?: number; toneHz?: number }) => void
  /**
   * ESP32 only, null elsewhere: the PDM microphone's clock, data and power
   * GPIO (docs/voice-chat.md; fos_mic.c), -1 = none, undefined = the board's
   * own. The cloud pushes `mic_clk_pin` / `mic_data_pin` / `mic_pwr_pin`; the
   * backend keeps `micClkPin` / `micDataPin` / `micPwrPin` in device_config
   * for the device's settings poll. `board*` is the board's own pin, what an
   * empty field means: a cloud frame's reported one (`hardware.micClkPin` …),
   * else its preset's (E1001/E1002: 42, 41, 38), else -1 (none);
   * `disabledReason` the cloud firmware floor (the voice chat's).
   */
  microphone: {
    clkPin: number | undefined
    dataPin: number | undefined
    pwrPin: number | undefined
    boardClkPin: number
    boardDataPin: number
    boardPwrPin: number
    disabledReason: string | undefined
  } | null
  setMicrophonePins: (patch: { clkPin?: number; dataPin?: number; pwrPin?: number }) => void
  /**
   * ESP32 only, null elsewhere: the board's status LED (fos_led.c), which
   * follows the buzzer's notes — lit for a press, a hold and the voice
   * chat's cues, with or instead of the beep. `pin` -1 = none, undefined =
   * the board's own; `type` how it is lit (gpio high, gpio_inverted low —
   * the reTerminal E-series —, ws2812 one pixel). The cloud pushes
   * `led_pin` / `led_type`; the backend keeps `ledPin` / `ledType` in
   * device_config for the device's settings poll. `reported*` is what a
   * cloud frame said it runs with (`hardware.ledPin` / `ledType`);
   * `disabledReason` the cloud firmware floor.
   */
  statusLed: {
    pin: number | undefined
    type: StatusLedType | undefined
    reportedPin: number | undefined
    reportedType: StatusLedType | undefined
    disabledReason: string | undefined
  } | null
  setStatusLed: (patch: { pin?: number; type?: StatusLedType }) => void
  /**
   * ESP32 with a microphone only, null elsewhere: voice chat, the key hold
   * that opens the board's microphone (docs/voice-chat.md; which key is
   * Button actions'). Null on a frame without a microphone (a cloud frame
   * that reported none and has no pins set, a backend frame whose pins and
   * preset name none): nothing to switch, so nothing is drawn. `enabled` is
   * the form's value (undefined = the frame's default, on); `reported` and
   * `microphone` what a cloud frame said in its hello (`hardware.voiceChat`,
   * `hardware.microphone`); `disabledReason` the cloud firmware floor.
   */
  voiceChat: {
    enabled: boolean | undefined
    reported: boolean | undefined
    microphone: boolean | undefined
    disabledReason: string | undefined
  } | null
  setVoiceChat: (enabled: boolean) => void
  /**
   * What the voice chat may do on this frame (docs/voice-chat.md "What the
   * voice chat may do"): the owner's three switches, null wherever `voiceChat`
   * is. Plane-side policy: the cloud form carries `voice_permissions` (its
   * own route, like the schedule), the backend keeps `voiceChangeSettings` /
   * `voiceUseScenes` / `voiceCreateScenes` in device_config; the device's
   * settings poll never carries them.
   */
  voicePermissions: VoicePermissions | null
  setVoicePermission: (key: VoicePermissionKey, enabled: boolean) => void

  appsWithSaveAssets: Record<string, string>
  logs: unknown[]
  ipAddresses: string[]
  showFrameInfo: boolean

  tlsEnabled: boolean
  /** The frame as the link builders should see it: saved values overlaid with the form. */
  linkFrame: FrameType
  url: string | null
  controlUrl: string | null
  adminUrl: string | null
  imageUrl: string | null
  adminLoginIsOnlyAccess: boolean
  embeddedAdminAuthMissing: boolean

  embeddedHardwarePreset: FrameEmbeddedHardwarePreset
  setEsp32HardwarePreset: (hardwarePreset: FrameEmbeddedHardwarePreset) => void
  setEsp32HardwarePresetCustom: (patch?: Partial<Pick<FrameType, 'device' | 'device_config' | 'embedded'>>) => void

  cloudPowerSettings: PowerSettingsValues
  setCloudPowerSettings: (patch: Partial<PowerSettingsValues>) => void
  embeddedPowerSettings: PowerSettingsValues
  setEmbeddedPowerSettings: (patch: Partial<PowerSettingsValues>) => void
  /** Real ESP32 hardware on the backend plane: not virtual, not a pico. */
  /** Which Power controls this board's firmware implements; null = none. */
  embeddedPowerProfile: EmbeddedPowerProfile | null
  showEmbeddedPowerSection: boolean

  virtualViewToken: string
  virtualImageUrl: string
  virtualPageUrl: string

  showWifiCredentials: boolean
  maxHttpResponsePlaceholder: string
  frameTimezoneOptions: Option[]
  timezoneUpdateHourValue: string
  timezoneUpdateUrlValue: string
  setTimezoneUpdaterValue: (patch: Partial<NonNullable<FrameType['timezone_updater']>>) => void
  setTimezoneUpdateHour: (rawValue: string) => void

  errorBehavior: NonNullable<FrameType['error_behavior']>
  errorBehaviorModes: FrameErrorBehaviorModeOption[]
  setErrorBehavior: (patch: Partial<NonNullable<FrameType['error_behavior']>>) => void

  mountpointItems: NonNullable<NonNullable<FrameType['mountpoints']>['items']>
  addMountpoint: () => void
  removeMountpoint: (index: number) => void

  deployedSshKeyIds: string[]
  selectedSshKeyIds: string[]
  hasSshKeyChangesToDeploy: boolean

  // The dropdown next to the first heading, and its loading flags.
  buildCacheLoading: boolean
  buildZipLoading: boolean
  cSourceZipLoading: boolean
  binaryZipLoading: boolean
  clearBuildCache: () => void
  downloadBuildZip: () => void
  downloadCSourceZip: () => void
  downloadBinaryZip: () => void
  deleteFrame: (frameId: FrameType['id']) => void
  downloadSdCardImage: (frameId: FrameType['id']) => void
}

const FrameSettingsContext = createContext<FrameSettingsContextValue | null>(null)

export function useFrameSettings(): FrameSettingsContextValue {
  const value = useContext(FrameSettingsContext)
  if (!value) {
    throw new Error('useFrameSettings() outside <FrameSettingsProvider>')
  }
  return value
}

const ERROR_BEHAVIOR_MODES: FrameErrorBehaviorModeOption[] = [
  {
    value: 'safe_mode',
    title: 'Fail hard',
    description: 'Restart through the service manager and let Boot Guard enter safe mode after repeated crashes.',
  },
  {
    value: 'show_error_retry',
    title: 'Show error, then retry',
    description: 'Render the fatal error on the frame, wait, then try to start FrameOS again.',
  },
  {
    value: 'silent_retry',
    title: 'Retry silently first',
    description: 'Keep the current image while retrying, optionally switching to the visible error screen later.',
  },
]

/**
 * Builds the context. Returns `null` while frameLogic has no frame yet — the
 * caller renders a spinner, exactly as the single component used to.
 */
export function FrameSettingsProvider({
  children,
  fallback,
  ...props
}: FrameSettingsProps & { children: ReactNode; fallback: ReactNode }): JSX.Element {
  const { mode, frameId, frame, frameForm, frameFormTouches } = useValues(frameLogic)
  const {
    touchFrameFormField,
    setFrameFormValues,
    updateDeployedSshKeys,
    forgetSshHostKey,
    generateFrameAdminCredentials,
    generateTlsCertificates,
    verifyTlsCertificates,
  } = useActions(frameLogic)
  const { deleteFrame, downloadSdCardImage } = useActions(framesModel)
  const { appsWithSaveAssets } = useValues(appsLogic({ frameId }))
  const { clearBuildCache, downloadBuildZip, downloadCSourceZip, downloadBinaryZip } = useActions(
    frameSettingsLogic({ frameId })
  )
  const { buildCacheLoading, buildZipLoading, cSourceZipLoading, binaryZipLoading } = useValues(
    frameSettingsLogic({ frameId })
  )
  const { openFrameTool } = useActions(workspaceLogic)
  const { logs, ipAddresses } = useValues(logsLogic({ frameId }))

  if (!frame) {
    return <>{fallback}</>
  }

  const openLogs = (): void => openFrameTool(frameId, 'logs')
  const inFrameAdminMode = isInFrameAdminMode()
  const workspaceSurfaceMode = workspaceMode()
  const surface = frameSettingsSurfaceFor(workspaceSurfaceMode, frame)
  const cloudProfile = surface === 'cloudLinux' || surface === 'cloudEsp32'
  const esp32CloudProfile = surface === 'cloudEsp32'

  // The 2026.8.30 batch (flip, error handling, control code, …) needs firmware
  // that knows the keys; see cloudFrameSupportsExtendedSettings for what an
  // unknown or missing version means.
  const cloudExtendedSettingsSupported = cloudProfile && cloudFrameSupportsExtendedSettings(frame.frameos_version)
  // The 2026.8.31 hardware batch (palette, partial refresh, GPIO buttons)
  // has its own floor, and which of its fields apply depends on the panel
  // the device reported at enrollment — a cloud frame's `device` is the one
  // in frame.hardware, never a form value.
  const cloudHardwareSettingsSupported = cloudProfile && cloudFrameSupportsHardwareSettings(frame.frameos_version)
  // 2026.9.22: the display driver itself (Pi/Linux only), applied with driver
  // setup on the frame.
  const cloudDisplayDriverSupported =
    surface === 'cloudLinux' && cloudFrameSupportsDisplayDriverSetting(frame.frameos_version)
  // The ESP32 firmware's own 2026.8.31 additions: debug logging, the HTTP
  // ceiling and GPIO buttons (esp32ExtendedCloudFrameSettingKeys).
  const cloudEsp32ExtendedSettingsSupported =
    esp32CloudProfile && cloudFrameSupportsEsp32ExtendedSettings(frame.frameos_version)
  // 2026.8.34: the chip maps an IANA name onto a POSIX TZ rule (fos_tz.c).
  const cloudEsp32TimeZoneSupported = esp32CloudProfile && cloudFrameSupportsEsp32TimeZone(frame.frameos_version)
  // 2026.8.39: the battery divider's enable GPIO joined the power keys. Below
  // the floor the field renders disabled with the reason (the push would be
  // refused whole), same as the tails above.
  const cloudEsp32BatteryEnablePinSupported =
    esp32CloudProfile && cloudFrameSupportsEsp32BatteryEnablePin(frame.frameos_version)
  const cloudBatteryEnablePinDisabledReason = cloudEsp32BatteryEnablePinSupported
    ? undefined
    : frame.frameos_version
    ? `The battery enable GPIO needs FrameOS ${esp32BatteryEnablePinCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to set it here.`
    : `The battery enable GPIO needs FrameOS ${esp32BatteryEnablePinCloudFrameSettingsMinVersion} or newer on the frame. It unlocks once the frame connects and reports its version.`

  const cloudDevice = cloudProfile ? frame.hardware?.device ?? '' : ''
  const embeddedHardwarePreset = normalizeEsp32HardwarePreset(
    frameForm.embedded?.hardwarePreset ?? frameForm.device_config?.hardwarePreset
  )
  const setEsp32HardwarePresetCustom = (
    patch: Partial<Pick<FrameType, 'device' | 'device_config' | 'embedded'>> = {}
  ): void => {
    const nextValues: Partial<FrameType> = {
      embedded: {
        ...(frameForm.embedded ?? {}),
        ...(patch.embedded ?? {}),
        hardwarePreset: 'custom',
      },
      device_config: {
        ...(frameForm.device_config ?? {}),
        ...(patch.device_config ?? {}),
        hardwarePreset: 'custom',
      },
    }
    if (patch.device !== undefined) {
      nextValues.device = patch.device
    }
    setFrameFormValues(nextValues)
  }
  const setEsp32HardwarePreset = (hardwarePreset: FrameEmbeddedHardwarePreset): void => {
    if (hardwarePreset === 'custom') {
      setEsp32HardwarePresetCustom()
      return
    }
    const presetConfig = esp32HardwarePresetConfig(hardwarePreset)
    if (!presetConfig) {
      return
    }
    const nextValues: Partial<FrameType> = {
      device: presetConfig.device,
      embedded: {
        ...(frameForm.embedded ?? {}),
        platform: presetConfig.platform,
        flashSize: presetConfig.flashSize,
        hardwarePreset,
      },
      device_config: {
        ...(frameForm.device_config ?? {}),
        hardwarePreset,
        psramMB: presetConfig.psramMB,
        pins: { ...presetConfig.pins },
        sdCardAssets: presetConfig.sdCardAssets,
      },
    }
    if (!frameForm.max_http_response_bytes || frameForm.max_http_response_bytes === DEFAULT_MAX_HTTP_RESPONSE_BYTES) {
      nextValues.max_http_response_bytes = EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    }
    setFrameFormValues(nextValues)
  }

  // What the device says its buttons are: the shape is the device's, so a
  // malformed entry drops rather than renders as "pin undefined".
  const reportedGpioButtonsOf = (value: unknown): GPIOButton[] | null => {
    if (!Array.isArray(value)) {
      return null
    }
    const buttons: GPIOButton[] = []
    for (const entry of value) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { pin?: unknown }).pin === 'number' &&
        typeof (entry as { label?: unknown }).label === 'string'
      ) {
        buttons.push({ pin: (entry as { pin: number }).pin, label: (entry as { label: string }).label })
      }
    }
    return buttons
  }
  // The hardware report first (an ESP32 reports its panel as the bare
  // waveshare key, `EPD_7in3e`, the palette table is keyed by driver name),
  // the frame's own `device` on backend-managed frames.
  const paletteDevice = paletteDeviceOf(frame)
  const normalizeKeyIds = (keys: string[]): string[] => Array.from(new Set(keys)).sort()
  const deployedSshKeyIds = normalizeKeyIds(
    (frame.last_successful_deploy?.ssh_keys as string[]) ?? frame.ssh_keys ?? []
  )
  const selectedSshKeyIds = normalizeKeyIds(frameForm.ssh_keys ?? frame.ssh_keys ?? [])

  const mountpoints = frameForm.mountpoints ?? { enabled: false, items: [] }
  const mountpointItems = mountpoints.items ?? []
  const setMountpoints = (nextMountpoints: NonNullable<FrameType['mountpoints']>): void => {
    setFrameFormValues({ mountpoints: nextMountpoints })
    touchFrameFormField('mountpoints')
  }

  const isBuildrootMode = mode === 'buildroot'
  const isEmbeddedMode = mode === 'embedded'
  // Virtual frames have no board at all: the backend renders them and serves
  // the result at the URLs shown in the "Virtual frame" section, so all
  // ESP32 hardware controls (panel, pins, flash, presets) are hidden.
  const isVirtualPlatform =
    isEmbeddedMode && (frameForm.embedded?.platform ?? frame.embedded?.platform) === EMBEDDED_VIRTUAL
  // View-only credential, never the device API key: leaking a kiosk URL
  // grants nothing but the picture. Rotate via device_config.viewToken.
  const virtualViewToken = frameForm.device_config?.viewToken ?? frame.device_config?.viewToken ?? ''
  const virtualUrlToken = virtualViewToken || '<view-token>'
  const virtualUrlOrigin = typeof window !== 'undefined' ? window.location.origin : ''

  // ESP32 power management, one component, two homes. The cloud pushes these
  // as top-level `set_settings` keys; the backend keeps them in device_config
  // and the device's settings poll reads them from there
  // (embedded_frame_settings in backend/app/api/embedded_device.py). Both
  // spellings of each key are accepted on read for the same reason the
  // backend accepts both — a device provisioned over its USB console writes
  // snake_case.
  const powerDeviceConfig = frameForm.device_config ?? frame.device_config ?? {}
  const embeddedPowerProfile = embeddedPowerProfileFor(frameForm.embedded?.platform ?? frame.embedded?.platform)
  const setCloudPowerSettings = (patch: Partial<PowerSettingsValues>): void => {
    setFrameFormValues({
      ...('batteryDivider' in patch ? { battery_divider: patch.batteryDivider } : {}),
      ...('batteryEnablePin' in patch ? { battery_enable_pin: patch.batteryEnablePin } : {}),
      ...('batteryPin' in patch ? { battery_pin: patch.batteryPin } : {}),
      ...('deepSleep' in patch ? { deep_sleep: patch.deepSleep } : {}),
      ...('deepSleepOnBattery' in patch ? { deep_sleep_on_battery: patch.deepSleepOnBattery } : {}),
      ...('wakeCheckSeconds' in patch ? { wake_check_seconds: patch.wakeCheckSeconds } : {}),
    })
  }
  const setEmbeddedPowerSettings = (patch: Partial<PowerSettingsValues>): void => {
    const next: NonNullable<FrameType['device_config']> = { ...powerDeviceConfig }
    const write = (
      key:
        | 'deepSleep'
        | 'deepSleepOnBattery'
        | 'wakeCheckSeconds'
        | 'batteryPin'
        | 'batteryDivider'
        | 'batteryEnablePin',
      snakeKey:
        | 'deep_sleep'
        | 'deep_sleep_on_battery'
        | 'wake_check_seconds'
        | 'battery_pin'
        | 'battery_divider'
        | 'battery_enable_pin'
    ): void => {
      if (!(key in patch)) {
        return
      }
      const value = patch[key]
      // The snake_case twin is what a USB-console provisioning writes. Drop it
      // whenever the camelCase one is written, or the device would keep
      // reading the stale copy it happens to check first.
      delete next[snakeKey]
      if (value === undefined) {
        delete next[key]
      } else {
        next[key] = value as never
      }
    }
    write('deepSleep', 'deep_sleep')
    write('deepSleepOnBattery', 'deep_sleep_on_battery')
    write('wakeCheckSeconds', 'wake_check_seconds')
    write('batteryPin', 'battery_pin')
    write('batteryDivider', 'battery_divider')
    write('batteryEnablePin', 'battery_enable_pin')
    setFrameFormValues({ device_config: next })
  }

  // The button-press chirp's buzzer, on the same two routes as the power
  // keys above. Real ESP32 boards only: a virtual frame has no buttons to
  // press, and the Pico firmware has no buzzer support.
  const isPicoPlatform = (frameForm.embedded?.platform ?? frame.embedded?.platform ?? '').startsWith('pico')
  const buttonBeep: FrameSettingsContextValue['buttonBeep'] = esp32CloudProfile
    ? {
        pin: frameForm.buzzer_pin,
        toneHz: frameForm.buzzer_tone_hz,
        reportedPin: typeof frame.hardware?.buzzerPin === 'number' ? frame.hardware.buzzerPin : undefined,
        reportedToneHz: typeof frame.hardware?.buzzerToneHz === 'number' ? frame.hardware.buzzerToneHz : undefined,
        disabledReason: cloudFrameSupportsEsp32Buzzer(frame.frameos_version)
          ? undefined
          : frame.frameos_version
          ? `The button beep needs FrameOS ${esp32BuzzerCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to set it here.`
          : `The button beep needs FrameOS ${esp32BuzzerCloudFrameSettingsMinVersion} or newer on the frame. It unlocks once the frame connects and reports its version.`,
      }
    : !cloudProfile && isEmbeddedMode && !isVirtualPlatform && !isPicoPlatform
    ? {
        pin: powerDeviceConfig.buzzerPin ?? powerDeviceConfig.buzzer_pin,
        toneHz: powerDeviceConfig.buzzerToneHz ?? powerDeviceConfig.buzzer_tone_hz,
        reportedPin: undefined,
        reportedToneHz: undefined,
        disabledReason: undefined,
      }
    : null
  const setButtonBeep = (patch: { pin?: number; toneHz?: number }): void => {
    if (esp32CloudProfile) {
      setFrameFormValues({
        ...('pin' in patch ? { buzzer_pin: patch.pin } : {}),
        ...('toneHz' in patch ? { buzzer_tone_hz: patch.toneHz } : {}),
      })
      return
    }
    // Same rule as the power keys: the camelCase key wins, so drop the
    // snake_case copy a USB-console provisioning may have left behind.
    const next: NonNullable<FrameType['device_config']> = { ...powerDeviceConfig }
    const write = (
      key: 'buzzerPin' | 'buzzerToneHz',
      snakeKey: 'buzzer_pin' | 'buzzer_tone_hz',
      value: number | undefined
    ): void => {
      delete next[snakeKey]
      if (value === undefined) {
        delete next[key]
      } else {
        next[key] = value
      }
    }
    if ('pin' in patch) {
      write('buzzerPin', 'buzzer_pin', patch.pin)
    }
    if ('toneHz' in patch) {
      write('buzzerToneHz', 'buzzer_tone_hz', patch.toneHz)
    }
    setFrameFormValues({ device_config: next })
  }

  // The PDM microphone's pins (docs/voice-chat.md), on the same two routes as
  // the beep; the cloud floor is the voice chat's (one release). Real ESP32
  // boards only. The board's own pins (what an empty field means) are the
  // cloud frame's reported ones, else its preset's, else -1; a backend
  // frame's are its preset's. The pins the frame runs with are the configured
  // ones over those, and name a microphone when clock and data are GPIOs:
  // one rule for the placeholders, the voice chat controls and the "Voice
  // chat" button action, so an E1004 (no microphone) shows the pins field
  // with "-1" and nothing else of the voice chat.
  const boardMicPins = esp32CloudProfile
    ? boardMicrophonePins({
        hardwarePreset: frame.hardware?.hardwarePreset,
        reported: { clk: frame.hardware?.micClkPin, data: frame.hardware?.micDataPin, pwr: frame.hardware?.micPwrPin },
      })
    : boardMicrophonePins({ hardwarePreset: embeddedHardwarePreset })
  const configuredMicPins = esp32CloudProfile
    ? { clk: frameForm.mic_clk_pin, data: frameForm.mic_data_pin, pwr: frameForm.mic_pwr_pin }
    : configuredMicrophonePinsOf(powerDeviceConfig)
  const hasMicrophone = microphonePinsNameOne(effectiveMicrophonePins(configuredMicPins, boardMicPins))
  const microphoneDisabledReason = cloudFrameSupportsEsp32VoiceChat(frame.frameos_version)
    ? undefined
    : frame.frameos_version
    ? `The microphone pins need FrameOS ${esp32VoiceChatCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to set them here.`
    : `The microphone pins need FrameOS ${esp32VoiceChatCloudFrameSettingsMinVersion} or newer on the frame. They unlock once the frame connects and reports its version.`
  const microphone: FrameSettingsContextValue['microphone'] = esp32CloudProfile
    ? {
        clkPin: frameForm.mic_clk_pin,
        dataPin: frameForm.mic_data_pin,
        pwrPin: frameForm.mic_pwr_pin,
        boardClkPin: boardMicPins.clk,
        boardDataPin: boardMicPins.data,
        boardPwrPin: boardMicPins.pwr,
        disabledReason: microphoneDisabledReason,
      }
    : !cloudProfile && isEmbeddedMode && !isVirtualPlatform && !isPicoPlatform
    ? {
        clkPin: configuredMicPins.clk,
        dataPin: configuredMicPins.data,
        pwrPin: configuredMicPins.pwr,
        boardClkPin: boardMicPins.clk,
        boardDataPin: boardMicPins.data,
        boardPwrPin: boardMicPins.pwr,
        disabledReason: undefined,
      }
    : null
  const setMicrophonePins = (patch: { clkPin?: number; dataPin?: number; pwrPin?: number }): void => {
    if (esp32CloudProfile) {
      setFrameFormValues({
        ...('clkPin' in patch ? { mic_clk_pin: patch.clkPin } : {}),
        ...('dataPin' in patch ? { mic_data_pin: patch.dataPin } : {}),
        ...('pwrPin' in patch ? { mic_pwr_pin: patch.pwrPin } : {}),
      })
      return
    }
    // Same rule as the beep: the camelCase key wins, so drop the snake_case
    // copy a USB-console provisioning may have left behind.
    const next: NonNullable<FrameType['device_config']> = { ...powerDeviceConfig }
    const write = (
      key: 'micClkPin' | 'micDataPin' | 'micPwrPin',
      snakeKey: 'mic_clk_pin' | 'mic_data_pin' | 'mic_pwr_pin',
      value: number | undefined
    ): void => {
      delete next[snakeKey]
      if (value === undefined) {
        delete next[key]
      } else {
        next[key] = value
      }
    }
    if ('clkPin' in patch) {
      write('micClkPin', 'mic_clk_pin', patch.clkPin)
    }
    if ('dataPin' in patch) {
      write('micDataPin', 'mic_data_pin', patch.dataPin)
    }
    if ('pwrPin' in patch) {
      write('micPwrPin', 'mic_pwr_pin', patch.pwrPin)
    }
    setFrameFormValues({ device_config: next })
  }

  // The status LED (fos_led.c), on the same two routes as the beep it
  // follows; the cloud floor is the voice chat's release. Real ESP32 boards only.
  const ledType = (value: unknown): StatusLedType | undefined =>
    value === 'gpio' || value === 'gpio_inverted' || value === 'ws2812' ? value : undefined
  const statusLedDisabledReason = cloudFrameSupportsEsp32Led(frame.frameos_version)
    ? undefined
    : frame.frameos_version
    ? `The status LED needs FrameOS ${esp32LedCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to set it here.`
    : `The status LED needs FrameOS ${esp32LedCloudFrameSettingsMinVersion} or newer on the frame. It unlocks once the frame connects and reports its version.`
  const statusLed: FrameSettingsContextValue['statusLed'] = esp32CloudProfile
    ? {
        pin: frameForm.led_pin,
        type: ledType(frameForm.led_type),
        reportedPin: typeof frame.hardware?.ledPin === 'number' ? frame.hardware.ledPin : undefined,
        reportedType: ledType(frame.hardware?.ledType),
        disabledReason: statusLedDisabledReason,
      }
    : !cloudProfile && isEmbeddedMode && !isVirtualPlatform && !isPicoPlatform
    ? {
        pin: powerDeviceConfig.ledPin ?? powerDeviceConfig.led_pin,
        type: ledType(powerDeviceConfig.ledType ?? powerDeviceConfig.led_type),
        reportedPin: undefined,
        reportedType: undefined,
        disabledReason: undefined,
      }
    : null
  const setStatusLed = (patch: { pin?: number; type?: StatusLedType }): void => {
    if (esp32CloudProfile) {
      setFrameFormValues({
        ...('pin' in patch ? { led_pin: patch.pin } : {}),
        ...('type' in patch ? { led_type: patch.type } : {}),
      })
      return
    }
    // Same rule as the beep: the camelCase key wins, so drop the snake_case
    // copy a USB-console provisioning may have left behind.
    const next: NonNullable<FrameType['device_config']> = { ...powerDeviceConfig }
    if ('pin' in patch) {
      delete next.led_pin
      if (patch.pin === undefined) {
        delete next.ledPin
      } else {
        next.ledPin = patch.pin
      }
    }
    if ('type' in patch) {
      delete next.led_type
      if (patch.type === undefined) {
        delete next.ledType
      } else {
        next.ledType = patch.type
      }
    }
    setFrameFormValues({ device_config: next })
  }

  // Voice chat (docs/voice-chat.md), on the same two routes as the beep: the
  // cloud pushes `voice_chat`, the backend keeps `voiceChat` in device_config
  // for the device's settings poll. Real ESP32 boards only, and only ones
  // whose effective microphone pins (above) name one; `voice_chat` itself
  // defaulting to on changes nothing here. The pins field stays on every
  // board: it is how a microphone on a J2 header is declared, and once it
  // is, the controls below appear.
  const voiceChat: FrameSettingsContextValue['voiceChat'] = !hasMicrophone
    ? null
    : esp32CloudProfile
    ? {
        enabled: frameForm.voice_chat,
        reported: typeof frame.hardware?.voiceChat === 'boolean' ? frame.hardware.voiceChat : undefined,
        microphone: typeof frame.hardware?.microphone === 'boolean' ? frame.hardware.microphone : undefined,
        disabledReason: cloudFrameSupportsEsp32VoiceChat(frame.frameos_version)
          ? undefined
          : frame.frameos_version
          ? `Voice chat needs FrameOS ${esp32VoiceChatCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to set it here.`
          : `Voice chat needs FrameOS ${esp32VoiceChatCloudFrameSettingsMinVersion} or newer on the frame. It unlocks once the frame connects and reports its version.`,
      }
    : !cloudProfile && isEmbeddedMode && !isVirtualPlatform && !isPicoPlatform
    ? {
        enabled: powerDeviceConfig.voiceChat ?? powerDeviceConfig.voice_chat,
        reported: undefined,
        microphone: undefined,
        disabledReason: undefined,
      }
    : null
  const setVoiceChat = (enabled: boolean): void => {
    if (esp32CloudProfile) {
      setFrameFormValues({ voice_chat: enabled })
      return
    }
    const next: NonNullable<FrameType['device_config']> = { ...powerDeviceConfig }
    delete next.voice_chat
    next.voiceChat = enabled
    setFrameFormValues({ device_config: next })
  }
  // What the voice chat may do (docs/voice-chat.md "What the voice chat may
  // do"): the cloud form's `voice_permissions` object (saved through its own
  // route, like the schedule), the backend's three device_config keys.
  const voicePermissions: FrameSettingsContextValue['voicePermissions'] = !voiceChat
    ? null
    : esp32CloudProfile
    ? voicePermissionsOf(frameForm.voice_permissions ?? frame.voice_permissions)
    : voicePermissionsFromDeviceConfig(powerDeviceConfig)
  const setVoicePermission = (key: VoicePermissionKey, enabled: boolean): void => {
    if (esp32CloudProfile) {
      setFrameFormValues({
        voice_permissions: {
          ...voicePermissionsOf(frameForm.voice_permissions ?? frame.voice_permissions),
          [key]: enabled,
        },
      })
      return
    }
    setFrameFormValues({ device_config: deviceConfigWithVoicePermission(powerDeviceConfig, key, enabled) })
  }

  const selectedTimezone = frameForm.timezone ?? frame.timezone ?? ''
  const timezoneUpdater = frameForm.timezone_updater ?? {}
  const setTimezoneUpdaterValue = (patch: Partial<NonNullable<FrameType['timezone_updater']>>): void => {
    const next = { ...timezoneUpdater, ...patch }
    if (next.hour === undefined) {
      delete next.hour
    }
    if (!next.url) {
      delete next.url
    }
    setFrameFormValues({ timezone_updater: next })
  }
  const setTimezoneUpdateHour = (rawValue: string): void => {
    const value = rawValue.trim()
    if (!value) {
      setTimezoneUpdaterValue({ hour: undefined })
      return
    }
    if (!/^\d+$/.test(value)) {
      return
    }
    const hour = Number(value)
    if (hour >= 0 && hour <= 23) {
      setTimezoneUpdaterValue({ hour })
    }
  }
  const baseTimezoneOptions =
    mode === 'rpios' ? [{ value: '', label: 'Detect from frame' }, ...timezoneOptions] : timezoneOptions
  const frameTimezoneOptions =
    selectedTimezone && !baseTimezoneOptions.some((option) => option.value === selectedTimezone)
      ? [{ value: selectedTimezone, label: `${selectedTimezone} (detected)` }, ...baseTimezoneOptions]
      : baseTimezoneOptions

  const errorBehavior = normalizeFrameErrorBehavior(frameForm.error_behavior ?? frame.error_behavior)
  const setErrorBehavior = (patch: Partial<NonNullable<FrameType['error_behavior']>>): void => {
    setFrameFormValues({ error_behavior: normalizeFrameErrorBehavior({ ...errorBehavior, ...patch }) })
  }

  const linkFrame: FrameType = {
    ...frame,
    frame_access: frameForm.frame_access ?? frame.frame_access,
    frame_access_key: frameForm.frame_access_key ?? frame.frame_access_key,
    frame_admin_auth: {
      ...(frame.frame_admin_auth ?? {}),
      ...(frameForm.frame_admin_auth ?? {}),
    },
  }

  const value: FrameSettingsContextValue = {
    ...props,
    surface,
    workspaceSurfaceMode,
    inFrameAdminMode,

    frameId,
    frame,
    frameForm,
    frameFormTouches,
    mode,
    isBuildrootMode,
    isEmbeddedMode,
    isVirtualPlatform,

    setFrameFormValues,
    touchFrameFormField,
    updateDeployedSshKeys,
    forgetSshHostKey,
    generateFrameAdminCredentials,
    generateTlsCertificates,
    verifyTlsCertificates,
    openLogs,

    cloudExtendedSettingsSupported,
    cloudHardwareSettingsSupported,
    cloudDisplayDriverSupported,
    cloudEsp32ExtendedSettingsSupported,
    cloudEsp32TimeZoneSupported,
    cloudBatteryEnablePinDisabledReason,

    paletteDevice,
    palette: withCustomPalette[paletteDevice],
    configuredGpioButtons: !isEmbeddedMode
      ? configuredGpioButtonsForDevice(cloudProfile ? cloudDevice : frameForm.device)
      : null,
    reportedGpioButtons: cloudProfile ? reportedGpioButtonsOf(frame.hardware?.gpioButtons) : null,
    buttonBeep,
    setButtonBeep,
    microphone,
    setMicrophonePins,
    statusLed,
    setStatusLed,
    voiceChat,
    setVoiceChat,
    voicePermissions,
    setVoicePermission,

    appsWithSaveAssets,
    logs,
    ipAddresses,
    showFrameInfo: !!frame.frame_host || (!inFrameAdminMode && logs.length > 0),

    tlsEnabled: !!(frameForm.https_proxy?.enable ?? frame.https_proxy?.enable),
    linkFrame,
    url: frameUrl(linkFrame),
    controlUrl: frameControlUrl(linkFrame),
    adminUrl: frameAdminUrl(linkFrame),
    imageUrl: frameImageUrl(linkFrame),
    adminLoginIsOnlyAccess: frameAdminLoginIsOnlyAccess(frame),
    embeddedAdminAuthMissing:
      isEmbeddedMode &&
      !(linkFrame.frame_admin_auth?.enabled && linkFrame.frame_admin_auth.user && linkFrame.frame_admin_auth.pass),

    embeddedHardwarePreset,
    setEsp32HardwarePreset,
    setEsp32HardwarePresetCustom,

    cloudPowerSettings: {
      batteryDivider: frameForm.battery_divider,
      batteryEnablePin: frameForm.battery_enable_pin,
      batteryPin: frameForm.battery_pin,
      deepSleep: frameForm.deep_sleep === true,
      deepSleepOnBattery: frameForm.deep_sleep_on_battery === true,
      wakeCheckSeconds: frameForm.wake_check_seconds,
    },
    setCloudPowerSettings,
    embeddedPowerSettings: {
      batteryDivider: powerDeviceConfig.batteryDivider ?? powerDeviceConfig.battery_divider,
      batteryEnablePin: powerDeviceConfig.batteryEnablePin ?? powerDeviceConfig.battery_enable_pin,
      batteryPin: powerDeviceConfig.batteryPin ?? powerDeviceConfig.battery_pin,
      deepSleep: (powerDeviceConfig.deepSleep ?? powerDeviceConfig.deep_sleep) === true,
      deepSleepOnBattery: (powerDeviceConfig.deepSleepOnBattery ?? powerDeviceConfig.deep_sleep_on_battery) === true,
      wakeCheckSeconds: powerDeviceConfig.wakeCheckSeconds ?? powerDeviceConfig.wake_check_seconds,
    },
    setEmbeddedPowerSettings,
    // Backend/on-device planes: real hardware only — a virtual frame has no
    // battery and never sleeps. The profile picks the controls: every knob on
    // an ESP32, deep sleep alone on a Pico (all its firmware implements).
    embeddedPowerProfile,
    showEmbeddedPowerSection:
      !cloudProfile &&
      isEmbeddedMode &&
      embeddedPowerProfile !== null &&
      frameSettingsSectionIsAllowed(workspaceSurfaceMode, 'frame-settings-power', frame),

    virtualViewToken,
    virtualImageUrl: `${virtualUrlOrigin}/api/frames/${frame.id}/virtual/image?k=${virtualUrlToken}`,
    virtualPageUrl: `${virtualUrlOrigin}/api/frames/${frame.id}/virtual/page?k=${virtualUrlToken}`,

    // A Buildroot frame's Wi-Fi credentials are baked into its SD card /
    // first-boot payload by the backend; the runtime never reads them from
    // frame.json (it joins networks through the setup portal). On the
    // device itself the fields would save a password that does nothing.
    showWifiCredentials: isEmbeddedMode || (isBuildrootMode && !inFrameAdminMode),
    maxHttpResponsePlaceholder: String(
      isEmbeddedMode || esp32CloudProfile ? EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES : DEFAULT_MAX_HTTP_RESPONSE_BYTES
    ),
    frameTimezoneOptions,
    timezoneUpdateHourValue:
      typeof timezoneUpdater.hour === 'number' && Number.isInteger(timezoneUpdater.hour)
        ? String(timezoneUpdater.hour)
        : '',
    timezoneUpdateUrlValue: timezoneUpdater.url ?? '',
    setTimezoneUpdaterValue,
    setTimezoneUpdateHour,

    errorBehavior,
    errorBehaviorModes: ERROR_BEHAVIOR_MODES,
    setErrorBehavior,

    mountpointItems,
    addMountpoint: () =>
      setMountpoints({ ...mountpoints, enabled: true, items: [...mountpointItems, newMountpoint()] }),
    removeMountpoint: (index: number) =>
      setMountpoints({ ...mountpoints, items: mountpointItems.filter((_, itemIndex) => itemIndex !== index) }),

    deployedSshKeyIds,
    selectedSshKeyIds,
    hasSshKeyChangesToDeploy: !equal(deployedSshKeyIds, selectedSshKeyIds),

    buildCacheLoading,
    buildZipLoading,
    cSourceZipLoading,
    binaryZipLoading,
    clearBuildCache,
    downloadBuildZip,
    downloadCSourceZip,
    downloadBinaryZip,
    deleteFrame,
    downloadSdCardImage,
  }

  return <FrameSettingsContext.Provider value={value}>{children}</FrameSettingsContext.Provider>
}

export { DEFAULT_FRAME_ERROR_BEHAVIOR }
