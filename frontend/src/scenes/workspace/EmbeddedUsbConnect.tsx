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

import { Spinner } from '../../components/Spinner'
import { TextInput } from '../../components/TextInput'
import type { FrameType } from '../../types'
import { webSerialSupported as isWebSerialSupported, webSerialUnavailableReason } from '../../utils/webSerial'
import { EmbeddedReleaseFlasher } from './EmbeddedReleaseFlasher'
import { EmbeddedUsbFirmwareUpdate } from './EmbeddedUsbFirmwareUpdate'
import { embeddedUsbConnectLogic } from './embeddedUsbConnectLogic'

// The one USB card for an ESP32 frame, on both control planes. It reads the
// board's `status` once and shows the next step (usbBoardIdentity.ts):
//   silent         blank, other firmware or download mode: flash and set up
//   unprovisioned  FrameOS with no frame: send this frame's settings
//   this frame     status, firmware update, settings
//   other frame    re-provision only after a confirm
// Decisions live in embeddedUsbConnectLogic. On the cloud a blank board goes
// to the re-link panel below the card instead.

// fos_wifi_state_t in embedded/esp32/main/fos_wifi.h
const WIFI_STATE_LABELS = ['offline', 'connecting', 'connected', 'captive portal'] as const

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

function WifiSection({ frame }: { frame: FrameType }): JSX.Element {
  const logic = embeddedUsbConnectLogic({ frameId: frame.id, frame })
  const { busy, scanBusy, applyBusy, networks, ssid, password } = useValues(logic)
  const { scanNetworks, selectNetwork, setSsid, setPassword, applyWifi } = useActions(logic)
  return (
    <div className="space-y-2">
      <SectionLabel>Wi-Fi</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={scanNetworks} disabled={busy} className={secondaryButtonClass}>
          {scanBusy ? <Spinner /> : <WifiIcon className="h-4 w-4" />}
          {scanBusy ? 'Scanning' : 'Scan networks'}
        </button>
        <span className="frame-tool-muted text-xs leading-4">
          Takes a few seconds. The board drops off Wi-Fi while it scans.
        </span>
      </div>
      {networks !== null ? (
        networks.length > 0 ? (
          <div className="frameos-inset max-h-48 space-y-0.5 overflow-y-auto rounded-xl border p-1.5">
            {networks.map((network, index) => (
              <button
                key={`${network.ssid}-${index}`}
                type="button"
                onClick={() => selectNetwork(network.ssid)}
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
}

function FirmwareUpdateSection({ frame, label }: { frame: FrameType; label: string }): JSX.Element | null {
  const logic = embeddedUsbConnectLogic({ frameId: frame.id, frame })
  const { releaseAvailable } = useValues(logic)
  const { setUpdateBusy } = useActions(logic)
  if (!releaseAvailable) {
    return null
  }
  return (
    <div className="space-y-2">
      <SectionLabel>{label}</SectionLabel>
      <div className="frame-tool-muted text-xs leading-4">
        Installs the latest release. The board keeps its Wi-Fi and settings.
      </div>
      <EmbeddedUsbFirmwareUpdate frame={frame} onBusyChange={setUpdateBusy} label="Update firmware, keep settings" />
    </div>
  )
}

function ApplySettingsButton({
  frame,
  confirmForeign = false,
  primary = false,
  label,
}: {
  frame: FrameType
  confirmForeign?: boolean
  primary?: boolean
  label: string
}): JSX.Element {
  const logic = embeddedUsbConnectLogic({ frameId: frame.id, frame })
  const { busy, settingsBusy } = useValues(logic)
  const { applyFrameSettings } = useActions(logic)
  return (
    <button
      type="button"
      onClick={() => applyFrameSettings(confirmForeign)}
      disabled={busy}
      className={primary ? primaryButtonClass : secondaryButtonClass}
    >
      {settingsBusy ? <Spinner color={primary ? 'white' : undefined} /> : <Cog6ToothIcon className="h-4 w-4" />}
      {settingsBusy ? 'Sending settings' : label}
    </button>
  )
}

function BoardIdentity({ frame }: { frame: FrameType }): JSX.Element {
  const logic = embeddedUsbConnectLogic({ frameId: frame.id, frame })
  const {
    identity,
    probing,
    busy,
    canProvision,
    cloudManaged,
    releaseAvailable,
    frameName,
    versionLine,
    firmwareOutdated,
    status,
    wifiConfigured,
    wifiConnected,
  } = useValues(logic)
  const { recheck, setFlasherBusy } = useActions(logic)

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
            It may be blank, running other firmware, or still starting up.
            {canProvision && releaseAvailable
              ? ' Flash FrameOS and set it up as this frame:'
              : cloudManaged
              ? ' To set it up as this frame, use “Re-link a wiped board” below.'
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
            Try again if the board was still starting, or pick the other port if there were two.
          </span>
        </div>
      </div>
    )
  }

  if (identity.kind === 'unprovisioned') {
    return (
      <div className="space-y-3">
        <div className="text-sm leading-5 text-[color:var(--tool-strong)]">
          <span className="font-semibold">This board runs {versionLine} but is not set up as a frame yet.</span>{' '}
          <span className="frame-tool-muted">
            {canProvision
              ? 'Send it this frame’s settings over USB:'
              : cloudManaged
              ? 'Use “Re-link a wiped board” below to set it up as this frame.'
              : 'Set it up from the backend that manages this frame.'}
          </span>
        </div>
        {canProvision ? <ApplySettingsButton frame={frame} primary label="Set up as this frame" /> : null}
        {firmwareOutdated ? <FirmwareUpdateSection frame={frame} label="Older firmware" /> : null}
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
            ? 'Nothing changes unless you set it up as this frame. The other frame then loses it.'
            : cloudManaged
            ? 'To use it as this frame, use “Re-link a wiped board” below. The other frame then loses it.'
            : ''}
        </div>
        {canProvision ? <ApplySettingsButton frame={frame} confirmForeign label="Re-provision as this frame" /> : null}
      </div>
    )
  }

  const wifi = status?.wifi
  const config = status?.config
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

      {firmwareOutdated ? <FirmwareUpdateSection frame={frame} label="Firmware update available" /> : null}

      {canProvision ? (
        <div className="space-y-2">
          <SectionLabel>Settings</SectionLabel>
          <div className="frame-tool-muted text-xs leading-4">
            Send this frame’s settings to the board over USB and restart it. Useful when the board is offline.
          </div>
          <ApplySettingsButton frame={frame} label="Apply frame settings" />
        </div>
      ) : null}

      {!wifiConfigured || !wifiConnected ? <WifiSection frame={frame} /> : null}
    </div>
  )
}

function MoreSection({ frame, manualFlashCommand }: { frame: FrameType; manualFlashCommand?: string }): JSX.Element {
  const logic = embeddedUsbConnectLogic({ frameId: frame.id, frame })
  const {
    identity,
    busy,
    boardRunsFrameOS,
    firmwareOutdated,
    deviceVersion,
    latestRelease,
    wifiConfigured,
    wifiConnected,
    canProvision,
    releaseAvailable,
    restartBusy,
    factoryResetBusy,
    copied,
  } = useValues(logic)
  const { restartDevice, factoryReset, disconnectUsb, setFlasherBusy, copyManualCommand } = useActions(logic)
  const isThisFrame = identity?.kind === 'this-frame'
  const isUnprovisioned = identity?.kind === 'unprovisioned'

  return (
    <details className="group border-t border-[color:var(--tool-border)] pt-3">
      <summary className="frame-tool-muted cursor-pointer select-none text-xs font-semibold uppercase tracking-wide">
        More
      </summary>
      <div className="mt-3 space-y-4">
        {boardRunsFrameOS && (!isThisFrame || (wifiConfigured && wifiConnected)) ? <WifiSection frame={frame} /> : null}
        {boardRunsFrameOS && !firmwareOutdated && (isThisFrame || isUnprovisioned) ? (
          <FirmwareUpdateSection
            frame={frame}
            label={deviceVersion && latestRelease ? 'Reinstall the current release' : 'Firmware'}
          />
        ) : null}
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
              <button type="button" onClick={disconnectUsb} disabled={busy} className={secondaryButtonClass}>
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
              Erase the board, flash the latest release and set it up as this frame again. Everything on the board is
              lost, including Wi-Fi.
            </div>
            <EmbeddedReleaseFlasher frame={frame} onBusyChange={setFlasherBusy} label="Erase & flash FrameOS again" />
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
              and flash it with esptool (<code>pip install esptool</code>), then connect here to set the board up.
            </div>
            <pre className="frameos-inset whitespace-pre-wrap break-all rounded-xl border p-3 text-xs leading-5 text-[color:var(--tool-strong)]">
              <code>{manualFlashCommand}</code>
            </pre>
            <button
              type="button"
              onClick={() => copyManualCommand(manualFlashCommand)}
              className={secondaryButtonClass}
            >
              <ClipboardDocumentIcon className="h-4 w-4" />
              {copied ? 'Copied' : 'Copy flash command'}
            </button>
          </div>
        ) : null}
      </div>
    </details>
  )
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
  const logic = embeddedUsbConnectLogic({ frameId: frame.id, frame })
  const { connected, streamBusy, usbLogStreamState, probeError, busy, identityKnown, message, error } = useValues(logic)
  const { connectUsb, recheck } = useActions(logic)

  return (
    <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
      <div>
        <div className="text-sm font-semibold text-[color:var(--tool-strong)]">Connect over USB</div>
        <div className="frame-tool-muted mt-1 text-sm leading-5">
          Plug the board into this computer and connect. The browser checks what is on it and shows what to do next.
        </div>
      </div>

      {!webSerialSupported ? (
        <div className="frame-tool-muted text-xs leading-5">{webSerialUnavailableReason('Connecting over USB')}</div>
      ) : !connected ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={connectUsb} disabled={streamBusy} className={primaryButtonClass}>
            {streamBusy ? <Spinner color="white" /> : <CpuChipIcon className="h-4 w-4" />}
            {usbLogStreamState?.status === 'selecting'
              ? 'Select USB port'
              : usbLogStreamState?.status === 'connecting'
              ? 'Connecting'
              : 'Connect over USB'}
          </button>
          <span className="frame-tool-muted text-xs leading-4">
            If you see two ports, either works. “USB JTAG/serial debug unit” is faster.
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
            <BoardIdentity frame={frame} />
          )}
          {identityKnown ? <MoreSection frame={frame} manualFlashCommand={manualFlashCommand} /> : null}
        </>
      )}

      {message ? <div className="text-xs font-semibold text-green-600">{message}</div> : null}
      {error ? <div className="text-xs font-semibold text-red-500">{error}</div> : null}
    </div>
  )
}
