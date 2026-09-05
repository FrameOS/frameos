import { useEffect, useRef, useState } from 'react'
import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  LockClosedIcon,
  StopCircleIcon,
  TrashIcon,
  WifiIcon,
} from '@heroicons/react/24/outline'
import copy from 'copy-to-clipboard'

import { Spinner } from '../../components/Spinner'
import { TextInput } from '../../components/TextInput'
import { frameHost } from '../../decorators/frame'
import {
  embeddedUsbLogsModel,
  isEmbeddedUsbLogStreamOpen,
  runEmbeddedUsbApiCommand,
  startEmbeddedUsbLogStream,
  usbFactoryReset,
  usbProvisionWifi,
  usbRestart,
  usbWifiScan,
  type EmbeddedUsbStatus,
  type EmbeddedUsbWifiNetwork,
} from '../../models/embeddedUsbLogsModel'
import type { FrameType } from '../../types'
import { webSerialSupported as isWebSerialSupported, webSerialUnavailableReason } from '../../utils/webSerial'
import {
  EmbeddedReleaseFlasher,
  fetchProvisioningPlan,
  provisionOverUsb,
  skippedSettingsNotice,
  type EmbeddedProvisioningPlan,
} from './EmbeddedReleaseFlasher'
import {
  EmbeddedUsbFirmwareUpdate,
  fetchReleaseFirmwareListing,
  hasReleaseFirmwarePlatform,
} from './EmbeddedUsbFirmwareUpdate'
import {
  classifyUsbBoard,
  isUsbSilenceError,
  normalizedFirmwareVersion,
  type UsbBoardIdentity,
} from './usbBoardIdentity'
import { workspaceLogic } from './workspaceLogic'
import { isEsp32CloudFrame, workspaceMode } from './workspaceSurfaces'

// ONE USB action for an ESP32 frame, on both control planes.
//
// The deploy drawer used to offer three USB cards side by side — "Flash latest
// release" (write the whole chip, then provision), "Update over USB" (write
// around NVS, keep settings) and "USB setup" (console only) — which read cold
// as the same thing (user, 2026-09-05, first time provisioning a C3: "we need
// to make this much simpler"). The board itself already says which applies,
// so this card asks it: connect, read `status` once over the USB API, and show
// ONE next step from what came back (usbBoardIdentity.ts):
//
//   silent          blank board / other firmware / ROM download mode →
//                   flash the release for its flash size and provision it
//   unprovisioned   runs FrameOS, set up for no frame → apply this frame's
//                   settings (no reflash)
//   this frame      status line; "Update firmware, keep settings" and "Apply
//                   settings" as the secondary actions
//   other frame     say so; re-provisioning is an explicit, confirmed click
//
// The three flows keep their code (EmbeddedReleaseFlasher,
// EmbeddedUsbFirmwareUpdate, and the Wi-Fi/restart/reset console verbs that
// used to be EmbeddedUsbSetup); this card only decides which to show. It is
// the same shape as the cloud's "Add frame" flasher (Esp32CloudFlasher):
// plug in, one button, the browser does the rest.
//
// The cloud deploy drawer mounts the same card. There the "flash a blank
// board" answer is the re-link panel underneath it (minting a claim token is
// a cloud operation the shared bundle cannot do), so the card points at it.

// fos_wifi_state_t in embedded/esp32/main/fos_wifi.h
const WIFI_STATE_LABELS = ['offline', 'connecting', 'connected', 'captive portal'] as const
const PROBE_TIMEOUT_MS = 8000

function wifiStateLabel(state?: number): string {
  return (state !== undefined && WIFI_STATE_LABELS[state]) || 'unknown'
}

function signalLabel(rssi: number): string {
  if (rssi >= -55) {
    return 'excellent'
  }
  if (rssi >= -67) {
    return 'good'
  }
  if (rssi >= -75) {
    return 'fair'
  }
  return 'weak'
}

function networkIsOpen(auth: string): boolean {
  return auth.toLowerCase() === 'open'
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const secondaryButtonClass =
  'frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'
const primaryButtonClass =
  'frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'
const dangerButtonClass =
  'frameos-danger-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-40'

function StatusRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-sm leading-5">
      <span className="frame-tool-muted shrink-0">{label}</span>
      <span className="min-w-0 break-all font-semibold text-[color:var(--tool-strong)]">{value}</span>
    </div>
  )
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">{children}</div>
}

export function EmbeddedUsbConnect({
  frame,
  manualFlashCommand,
}: {
  frame: FrameType
  // The by-hand esptool recipe (backend drawer); shown in the details fold.
  manualFlashCommand?: string
}): JSX.Element {
  const webSerialSupported = isWebSerialSupported()
  const mode = workspaceMode()
  const cloudManaged = isEsp32CloudFrame(frame)
  const frameName = frame.name || frameHost(frame)
  const { openFrameToolBehindDrawer } = useActions(workspaceLogic)
  const { stopUsbLogStream } = useActions(embeddedUsbLogsModel)
  const { usbLogStreamStatesByFrameId } = useValues(embeddedUsbLogsModel)
  const usbLogStreamState = usbLogStreamStatesByFrameId[frame.id]
  const usbLogStreamOpen = isEmbeddedUsbLogStreamOpen(usbLogStreamState)
  const streaming = usbLogStreamState?.status === 'streaming'
  const streamBusy =
    usbLogStreamState?.status === 'selecting' ||
    usbLogStreamState?.status === 'connecting' ||
    usbLogStreamState?.status === 'stopping'

  // The self-hosted backend knows what a stock image must be told to become
  // this frame; the cloud pushes its settings over the hub instead, and a
  // device's own admin bundle has no plan to fetch.
  const canProvision = !cloudManaged && mode === 'backend'
  // Both control planes serve the release listing; the device's own admin
  // bundle serves neither that nor the firmware bytes.
  const releaseAvailable = mode !== 'frameAdmin' && hasReleaseFirmwarePlatform(frame)

  const [plan, setPlan] = useState<EmbeddedProvisioningPlan | null>(null)
  const [latestRelease, setLatestRelease] = useState<string | null>(null)
  const [identity, setIdentity] = useState<UsbBoardIdentity | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const probedRef = useRef(false)
  const probingRef = useRef(false)

  const [flasherBusy, setFlasherBusy] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [restartBusy, setRestartBusy] = useState(false)
  const [factoryResetBusy, setFactoryResetBusy] = useState(false)
  const [scanBusy, setScanBusy] = useState(false)
  const [applyBusy, setApplyBusy] = useState(false)
  const [networks, setNetworks] = useState<EmbeddedUsbWifiNetwork[] | null>(null)
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const flowBusy = flasherBusy || updateBusy
  const actionBusy = settingsBusy || restartBusy || factoryResetBusy || scanBusy || applyBusy
  const busy = flowBusy || actionBusy || probing
  const connected = webSerialSupported && (usbLogStreamOpen || flowBusy)
  const expectedBackendUrl = plan?.settings.find((setting) => setting.key === 'backend')?.value ?? null

  useEffect(() => {
    setPlan(null)
    setLatestRelease(null)
    setIdentity(null)
    setProbeError(null)
    setMessage(null)
    setError(null)
    setNetworks(null)
    probedRef.current = false
    let cancelled = false
    if (canProvision) {
      fetchProvisioningPlan(frame.id)
        .then((fetched) => {
          if (!cancelled) {
            setPlan(fetched)
          }
        })
        .catch(() => {
          // The flasher fetches its own copy and reports; here the plan only
          // sharpens the identity check and the "set up" button.
        })
    }
    if (releaseAvailable) {
      fetchReleaseFirmwareListing()
        .then((listing) => {
          if (!cancelled) {
            setLatestRelease(normalizedFirmwareVersion(listing.release))
          }
        })
        .catch(() => {
          // Without it the status line just omits "latest".
        })
    }
    return () => {
      cancelled = true
    }
  }, [frame.id, canProvision, releaseAvailable])

  const probe = async (): Promise<void> => {
    if (probingRef.current) {
      return
    }
    probingRef.current = true
    probedRef.current = true
    setProbing(true)
    setProbeError(null)
    try {
      const result = await runEmbeddedUsbApiCommand(frame.id, 'status', {
        timeoutMs: PROBE_TIMEOUT_MS,
        mirrorOutput: false,
        probe: true,
      })
      let status: EmbeddedUsbStatus | null = null
      try {
        status = JSON.parse(result.text ?? '') as EmbeddedUsbStatus
      } catch {
        status = null
      }
      setIdentity(
        classifyUsbBoard(
          frame,
          status,
          mode,
          expectedBackendUrl,
          'The board answered on USB, but not with a FrameOS status.'
        )
      )
    } catch (probeFailure) {
      if (isUsbSilenceError(probeFailure)) {
        setIdentity(classifyUsbBoard(frame, null, mode, expectedBackendUrl))
      } else {
        setProbeError(errorDetail(probeFailure))
      }
    } finally {
      probingRef.current = false
      setProbing(false)
    }
  }

  // Read the board once per USB session, as soon as the log stream is up.
  // Every USB API command stops and resumes that stream (so does a flash), so
  // "streaming again" re-arms the probe — but only while nothing of ours is
  // running, or every step of an action would trigger a re-read.
  useEffect(() => {
    if (!connected && !flowBusy) {
      probedRef.current = false
      setIdentity(null)
      setNetworks(null)
      return
    }
    if (streaming && !probedRef.current && !busy) {
      void probe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, streaming, flowBusy, busy])

  const connect = async (): Promise<void> => {
    setError(null)
    setMessage(null)
    const started = await startEmbeddedUsbLogStream(frame.id)
    if (started) {
      openFrameToolBehindDrawer(frame.id, 'logs')
    }
  }

  const recheck = (): void => {
    probedRef.current = false
    void probe()
  }

  const applyFrameSettings = async (confirmForeign = false): Promise<void> => {
    if (confirmForeign && identity?.kind === 'other-frame') {
      if (
        !window.confirm(
          `This board is currently ${identity.label}. Re-provision it as "${frameName}"? It stops being that other frame.`
        )
      ) {
        return
      }
    }
    setSettingsBusy(true)
    setError(null)
    setMessage(null)
    try {
      const currentPlan = plan ?? (await fetchProvisioningPlan(frame.id))
      if (!currentPlan.supported) {
        setError(`This frame cannot be provisioned yet: ${currentPlan.blockers.join(' ')}`)
        return
      }
      const { skipped } = await provisionOverUsb(frame.id, currentPlan, null, setMessage)
      const sent = currentPlan.settings.length - skipped.length
      setMessage(`Sent ${sent} settings to the board; restarting it to apply them.`)
      await usbRestart(frame.id)
      const notice = skippedSettingsNotice(skipped)
      setMessage(`Sent ${sent} settings to the board. It rebooted and is applying them.${notice ? ` ${notice}` : ''}`)
      probedRef.current = false
      await probe()
    } catch (settingsError) {
      setError(`Applying the frame's settings failed: ${errorDetail(settingsError)}`)
    } finally {
      setSettingsBusy(false)
    }
  }

  const scanNetworks = async (): Promise<void> => {
    setScanBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await usbWifiScan(frame.id)
      // Hidden networks scan as an empty SSID and cannot be selected here.
      setNetworks(result.networks.filter((network) => network.ssid.length > 0))
    } catch (scanError) {
      setError(`Wi-Fi scan failed: ${errorDetail(scanError)}`)
    } finally {
      setScanBusy(false)
    }
  }

  const applyWifi = async (): Promise<void> => {
    const targetSsid = ssid.trim()
    if (!targetSsid) {
      setError('Enter or select a Wi-Fi network name first.')
      return
    }
    setApplyBusy(true)
    setError(null)
    setMessage(null)
    try {
      await usbProvisionWifi(frame.id, targetSsid, password)
      setPassword('')
      setMessage(`Wi-Fi settings saved. The device rebooted and is joining "${targetSsid}".`)
      probedRef.current = false
      await probe()
    } catch (applyError) {
      setError(`Applying Wi-Fi settings failed: ${errorDetail(applyError)}`)
    } finally {
      setApplyBusy(false)
    }
  }

  const restartDevice = async (): Promise<void> => {
    setRestartBusy(true)
    setError(null)
    setMessage(null)
    try {
      await usbRestart(frame.id)
      setMessage('Restart acknowledged. The device rebooted and the USB session reconnected.')
      probedRef.current = false
      await probe()
    } catch (restartError) {
      setError(`Restart failed: ${errorDetail(restartError)}`)
    } finally {
      setRestartBusy(false)
    }
  }

  const factoryReset = async (): Promise<void> => {
    // A reset is `nvs_erase_all` on the whole frameos namespace (fos_config.c),
    // which takes a cloud enrollment with it — cloud_url, cloud_fid and the
    // device token all live there. On a cloud-managed frame that is not a
    // reset but an unlink, so say so.
    if (
      !window.confirm(
        cloudManaged
          ? `Factory reset "${frameName}"? This erases everything the board has stored — Wi-Fi, hardware settings AND its enrollment in this account. It will NOT come back as this frame: re-link it afterwards from "Re-link a wiped board", and this frame row is left behind empty until then. To install new firmware, use "Update firmware, keep settings" instead. This cannot be undone.`
          : `Factory reset "${frameName}"? This erases the device's Wi-Fi, backend and hardware settings and reboots it. This cannot be undone.`
      )
    ) {
      return
    }
    setFactoryResetBusy(true)
    setError(null)
    setMessage(null)
    try {
      await usbFactoryReset(frame.id)
      setNetworks(null)
      setMessage(
        cloudManaged
          ? 'Factory reset complete. The device erased its settings — including its enrollment — and rebooted.'
          : 'Factory reset complete. The device erased its settings and rebooted.'
      )
      probedRef.current = false
      await probe()
    } catch (resetError) {
      setError(`Factory reset failed: ${errorDetail(resetError)}`)
    } finally {
      setFactoryResetBusy(false)
    }
  }

  const status = identity && identity.kind !== 'silent' ? identity.status : null
  const deviceVersion = normalizedFirmwareVersion(status?.version)
  const firmwareOutdated = Boolean(deviceVersion && latestRelease && deviceVersion !== latestRelease)
  const wifi = status?.wifi
  const config = status?.config
  const wifiConfigured = Boolean(config?.wifiSsid)
  const wifiConnected = wifi?.state === 2

  const renderWifiSection = (): JSX.Element => (
    <div className="space-y-2">
      <SectionLabel>Wi-Fi</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={scanNetworks} disabled={busy} className={secondaryButtonClass}>
          {scanBusy ? <Spinner /> : <WifiIcon className="h-4 w-4" />}
          {scanBusy ? 'Scanning' : 'Scan networks'}
        </button>
        <span className="frame-tool-muted text-xs leading-4">
          The scan takes a few seconds and briefly drops the device's Wi-Fi.
        </span>
      </div>
      {networks !== null ? (
        networks.length > 0 ? (
          <div className="frameos-inset max-h-48 space-y-0.5 overflow-y-auto rounded-xl border p-1.5">
            {networks.map((network, index) => (
              <button
                key={`${network.ssid}-${index}`}
                type="button"
                onClick={() => {
                  setSsid(network.ssid)
                  setPassword('')
                  setMessage(null)
                  setError(null)
                }}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                  ssid === network.ssid
                    ? 'frameos-primary-action font-semibold'
                    : 'frameos-clear-button text-[color:var(--tool-strong)]'
                )}
              >
                {ssid === network.ssid ? (
                  <CheckCircleIcon className="h-4 w-4 shrink-0" />
                ) : networkIsOpen(network.auth) ? (
                  <WifiIcon className="h-4 w-4 shrink-0 opacity-60" />
                ) : (
                  <LockClosedIcon className="h-4 w-4 shrink-0 opacity-60" />
                )}
                <span className="min-w-0 flex-1 truncate">{network.ssid}</span>
                <span className="shrink-0 text-xs opacity-70">
                  {networkIsOpen(network.auth) ? 'open' : network.auth}
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs opacity-70">
                  {network.rssi} dBm ({signalLabel(network.rssi)})
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="frame-tool-muted text-sm leading-5">No networks found. Try scanning again.</div>
        )
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[10rem] flex-1">
          <span className="frame-tool-muted mb-1 block text-xs font-semibold">Network name (SSID)</span>
          <TextInput value={ssid} onChange={setSsid} placeholder="Scan or type an SSID" disabled={busy} />
        </label>
        <label className="min-w-[10rem] flex-1">
          <span className="frame-tool-muted mb-1 block text-xs font-semibold">Password</span>
          <TextInput
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Leave empty for open networks"
            disabled={busy}
            autoComplete="off"
          />
        </label>
        <button type="button" onClick={applyWifi} disabled={busy || !ssid.trim()} className={primaryButtonClass}>
          {applyBusy ? <Spinner color="white" /> : <WifiIcon className="h-4 w-4" />}
          {applyBusy ? 'Applying' : 'Join & restart'}
        </button>
      </div>
    </div>
  )

  const renderFirmwareUpdate = (label: string): JSX.Element | null =>
    releaseAvailable ? (
      <div className="space-y-2">
        <SectionLabel>{label}</SectionLabel>
        <div className="frame-tool-muted text-xs leading-4">
          Writes the latest published release around the board's settings partition, so it keeps its Wi-Fi, its identity
          and every saved setting.
        </div>
        <EmbeddedUsbFirmwareUpdate frame={frame} onBusyChange={setUpdateBusy} label="Update firmware, keep settings" />
      </div>
    ) : null

  const renderIdentity = (): JSX.Element => {
    if (probing || !identity) {
      return (
        <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--tool-strong)]">
          <Spinner />
          Reading the board over USB
        </div>
      )
    }

    if (identity.kind === 'silent') {
      return (
        <div className="space-y-3">
          <div className="text-sm leading-5 text-[color:var(--tool-strong)]">
            <span className="font-semibold">{identity.detail}</span>{' '}
            <span className="frame-tool-muted">
              A blank board, one running other firmware, or one that reset into download mode all look like this.
              {canProvision && releaseAvailable
                ? ' Flash FrameOS onto it and set it up as this frame in one go:'
                : cloudManaged
                ? ' For a cloud frame, use “Re-link a wiped board” below — it flashes the release and enrolls the board as this frame in one go.'
                : ''}
            </span>
          </div>
          {canProvision && releaseAvailable ? (
            <EmbeddedReleaseFlasher
              frame={frame}
              onBusyChange={setFlasherBusy}
              label="Flash FrameOS & set up this frame"
              primary
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={recheck} disabled={busy} className={secondaryButtonClass}>
              <ArrowPathIcon className="h-4 w-4" />
              Read the board again
            </button>
            <span className="frame-tool-muted text-xs leading-4">
              If the board is mid-boot, or the port picker listed two ports and this is the other one, try again.
            </span>
          </div>
        </div>
      )
    }

    const versionLine = deviceVersion
      ? `FrameOS ${deviceVersion}${
          latestRelease ? (firmwareOutdated ? ` · latest ${latestRelease}` : ' · latest') : ''
        }`
      : 'FrameOS (version unknown)'

    if (identity.kind === 'unprovisioned') {
      return (
        <div className="space-y-3">
          <div className="text-sm leading-5 text-[color:var(--tool-strong)]">
            <span className="font-semibold">This board runs {versionLine}, but is not set up as any frame yet.</span>{' '}
            <span className="frame-tool-muted">
              {canProvision
                ? 'Send it this frame’s backend address, API key, panel, wiring and the rest of its settings over the cable:'
                : cloudManaged
                ? 'Use “Re-link a wiped board” below to enroll it as this frame.'
                : 'Provision it from the backend that manages this frame.'}
            </span>
          </div>
          {canProvision ? (
            <button type="button" onClick={() => applyFrameSettings()} disabled={busy} className={primaryButtonClass}>
              {settingsBusy ? <Spinner color="white" /> : <Cog6ToothIcon className="h-4 w-4" />}
              {settingsBusy ? 'Sending settings' : 'Set up as this frame'}
            </button>
          ) : null}
          {firmwareOutdated ? renderFirmwareUpdate('Older firmware') : null}
        </div>
      )
    }

    if (identity.kind === 'other-frame') {
      return (
        <div className="space-y-3">
          <div className="frameos-warning-button rounded-xl border px-3 py-2 text-sm leading-5">
            <span className="font-semibold">
              This board is {identity.label}, not “{frameName}”.
            </span>{' '}
            {canProvision
              ? 'Nothing is changed until you say so. Re-provisioning makes it this frame and it stops being that one.'
              : cloudManaged
              ? 'To make it this frame, use “Re-link a wiped board” below; that other frame loses the board.'
              : ''}
          </div>
          {canProvision ? (
            <button
              type="button"
              onClick={() => applyFrameSettings(true)}
              disabled={busy}
              className={secondaryButtonClass}
            >
              {settingsBusy ? <Spinner /> : <Cog6ToothIcon className="h-4 w-4" />}
              {settingsBusy ? 'Sending settings' : 'Re-provision as this frame'}
            </button>
          ) : null}
        </div>
      )
    }

    // this-frame
    return (
      <div className="space-y-4">
        <div className="frameos-inset space-y-1.5 rounded-xl border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-[color:var(--tool-strong)]">
              <CheckCircleIcon className="h-4 w-4 text-emerald-500" />
              This board is “{frameName}”
            </div>
            <button
              type="button"
              onClick={recheck}
              disabled={busy}
              className={clsx(secondaryButtonClass, 'px-2.5 py-1.5 text-xs')}
            >
              <ArrowPathIcon className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
          <StatusRow label="Firmware" value={versionLine} />
          <StatusRow
            label="Wi-Fi"
            value={
              config?.wifiSsid
                ? `${config.wifiSsid} (${wifiStateLabel(wifi?.state)}${
                    wifiConnected && typeof wifi?.rssi === 'number' ? `, ${wifi.rssi} dBm` : ''
                  })`
                : 'not configured'
            }
          />
          {wifi?.ip ? <StatusRow label="IP address" value={wifi.ip} /> : null}
          {config?.panel ? <StatusRow label="Panel" value={config.panel} /> : null}
        </div>

        {firmwareOutdated ? renderFirmwareUpdate('Firmware update available') : null}

        {canProvision ? (
          <div className="space-y-2">
            <SectionLabel>Settings</SectionLabel>
            <div className="frame-tool-muted text-xs leading-4">
              Resend this frame’s backend address, API key, panel, wiring, buttons and hardware settings over USB and
              restart — for when they changed here and the board is not on the network.
            </div>
            <button type="button" onClick={() => applyFrameSettings()} disabled={busy} className={secondaryButtonClass}>
              {settingsBusy ? <Spinner /> : <Cog6ToothIcon className="h-4 w-4" />}
              {settingsBusy ? 'Sending settings' : 'Apply frame settings'}
            </button>
          </div>
        ) : null}

        {!wifiConfigured || !wifiConnected ? renderWifiSection() : null}
      </div>
    )
  }

  const identityKnown = identity !== null && !probing
  const boardRunsFrameOS = identityKnown && identity.kind !== 'silent'

  return (
    <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
      <div>
        <div className="text-sm font-semibold text-[color:var(--tool-strong)]">Connect over USB</div>
        <div className="frame-tool-muted mt-1 text-sm leading-5">
          Plug the board into this computer, connect, and the browser reads what is on it and offers the one thing to do
          next — flash a blank board and set it up, finish setting up a fresh one, or update this frame. No network
          needed.
        </div>
      </div>

      {!webSerialSupported ? (
        <div className="frame-tool-muted text-xs leading-5">{webSerialUnavailableReason('Connecting over USB')}</div>
      ) : !connected ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={connect} disabled={streamBusy} className={primaryButtonClass}>
            {streamBusy ? <Spinner color="white" /> : <CpuChipIcon className="h-4 w-4" />}
            {usbLogStreamState?.status === 'selecting'
              ? 'Select USB port'
              : usbLogStreamState?.status === 'connecting'
              ? 'Connecting'
              : 'Connect over USB'}
          </button>
          <span className="frame-tool-muted text-xs leading-4">
            If the port picker lists two ports, either works — “USB JTAG/serial debug unit” is the faster one.
          </span>
        </div>
      ) : (
        <>
          {probeError ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-red-500">Could not read the board: {probeError}</div>
              <button type="button" onClick={recheck} disabled={busy} className={secondaryButtonClass}>
                <ArrowPathIcon className="h-4 w-4" />
                Try again
              </button>
            </div>
          ) : (
            renderIdentity()
          )}

          {identityKnown ? (
            <details className="group border-t border-[color:var(--tool-border)] pt-3">
              <summary className="frame-tool-muted cursor-pointer select-none text-xs font-semibold uppercase tracking-wide">
                More
              </summary>
              <div className="mt-3 space-y-4">
                {boardRunsFrameOS && identity.kind !== 'this-frame' ? renderWifiSection() : null}
                {boardRunsFrameOS && identity.kind === 'this-frame' && wifiConfigured && wifiConnected
                  ? renderWifiSection()
                  : null}
                {boardRunsFrameOS &&
                !firmwareOutdated &&
                (identity.kind === 'this-frame' || identity.kind === 'unprovisioned')
                  ? renderFirmwareUpdate(deviceVersion && latestRelease ? 'Reinstall the current release' : 'Firmware')
                  : null}
                {boardRunsFrameOS ? (
                  <div className="space-y-2">
                    <SectionLabel>Device</SectionLabel>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={restartDevice} disabled={busy} className={secondaryButtonClass}>
                        {restartBusy ? <Spinner /> : <ArrowPathIcon className="h-4 w-4" />}
                        {restartBusy ? 'Restarting' : 'Restart device'}
                      </button>
                      <button type="button" onClick={factoryReset} disabled={busy} className={dangerButtonClass}>
                        {factoryResetBusy ? <Spinner color="white" /> : <TrashIcon className="h-4 w-4" />}
                        {factoryResetBusy ? 'Resetting' : 'Factory reset'}
                      </button>
                      <button
                        type="button"
                        onClick={() => stopUsbLogStream(frame.id)}
                        disabled={busy}
                        className={secondaryButtonClass}
                      >
                        <StopCircleIcon className="h-4 w-4" />
                        Disconnect
                      </button>
                    </div>
                  </div>
                ) : null}
                {boardRunsFrameOS && canProvision && releaseAvailable ? (
                  <div className="space-y-2">
                    <SectionLabel>Start over</SectionLabel>
                    <div className="frame-tool-muted text-xs leading-4">
                      Erase the whole chip, write the published release for its flash size and provision this frame from
                      scratch. Everything stored on the board is lost, including its Wi-Fi settings.
                    </div>
                    <EmbeddedReleaseFlasher
                      frame={frame}
                      onBusyChange={setFlasherBusy}
                      label="Erase & flash FrameOS again"
                    />
                  </div>
                ) : null}
                {manualFlashCommand ? (
                  <div className="space-y-2">
                    <SectionLabel>By hand</SectionLabel>
                    <div className="frame-tool-muted text-xs leading-4">
                      Download{' '}
                      <a
                        href="https://github.com/FrameOS/frameos/releases/latest"
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        the release image
                      </a>{' '}
                      and flash it with esptool (<code>pip install esptool</code>), then connect here to set the board
                      up.
                    </div>
                    <pre className="frameos-inset whitespace-pre-wrap break-all rounded-xl border p-3 text-xs leading-5 text-[color:var(--tool-strong)]">
                      <code>{manualFlashCommand}</code>
                    </pre>
                    <button
                      type="button"
                      onClick={() => {
                        copy(manualFlashCommand)
                        setCopied(true)
                      }}
                      className={secondaryButtonClass}
                    >
                      <ClipboardDocumentIcon className="h-4 w-4" />
                      {copied ? 'Copied' : 'Copy flash command'}
                    </button>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
        </>
      )}

      {message ? <div className="text-xs font-semibold text-green-600">{message}</div> : null}
      {error ? <div className="text-xs font-semibold text-red-500">{error}</div> : null}
    </div>
  )
}
