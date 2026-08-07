import { useEffect, useRef, useState } from 'react'
import { useValues } from 'kea'
import clsx from 'clsx'
import { ArrowPathIcon, CheckCircleIcon, LockClosedIcon, TrashIcon, WifiIcon } from '@heroicons/react/24/outline'

import { Spinner } from '../../components/Spinner'
import { TextInput } from '../../components/TextInput'
import { frameHost } from '../../decorators/frame'
import {
  embeddedUsbApiCanUse,
  embeddedUsbLogsModel,
  isEmbeddedUsbLogStreamOpen,
  usbFactoryReset,
  usbProvisionWifi,
  usbRestart,
  usbStatus,
  usbWifiScan,
  type EmbeddedUsbStatus,
  type EmbeddedUsbWifiNetwork,
} from '../../models/embeddedUsbLogsModel'
import type { FrameType } from '../../types'
import { EmbeddedUsbConnectionButton } from './EmbeddedWebFlasher'

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

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function StatusRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-sm leading-5">
      <span className="frame-tool-muted shrink-0">{label}</span>
      <span className="min-w-0 break-all font-semibold text-[color:var(--tool-strong)]">{value}</span>
    </div>
  )
}

export function EmbeddedUsbSetup({ frame }: { frame: FrameType }): JSX.Element | null {
  const webSerialSupported = typeof navigator !== 'undefined' && 'serial' in navigator
  const { usbLogStreamStatesByFrameId } = useValues(embeddedUsbLogsModel)
  const usbLogStreamState = usbLogStreamStatesByFrameId[frame.id]
  const usbLogStreamOpen = isEmbeddedUsbLogStreamOpen(usbLogStreamState)
  // Re-evaluated on every stream-state change; embeddedUsbApiCanUse itself is
  // not reactive, but every connect/command/disconnect updates the stream
  // state, which re-renders this component.
  const usbConnected = webSerialSupported && (usbLogStreamOpen || embeddedUsbApiCanUse(frame.id))

  const [status, setStatus] = useState<EmbeddedUsbStatus | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [networks, setNetworks] = useState<EmbeddedUsbWifiNetwork[] | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [applyBusy, setApplyBusy] = useState(false)
  const [restartBusy, setRestartBusy] = useState(false)
  const [factoryResetBusy, setFactoryResetBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const statusAutoLoadedRef = useRef(false)

  const busy = statusBusy || scanBusy || applyBusy || restartBusy || factoryResetBusy
  const frameName = frame.name || frameHost(frame)

  const refreshStatus = async (): Promise<void> => {
    setStatusBusy(true)
    setError(null)
    try {
      setStatus(await usbStatus(frame.id))
    } catch (statusError) {
      setError(`Could not read device status: ${errorDetail(statusError)}`)
    } finally {
      setStatusBusy(false)
    }
  }

  // Load the status once per USB session, and only while the log stream is
  // actually streaming: the flasher stops the stream for the whole flash, so
  // gating on 'streaming' keeps this from racing an esptool session that
  // holds the port outside the command lock.
  useEffect(() => {
    if (!usbConnected) {
      statusAutoLoadedRef.current = false
      return
    }
    if (usbLogStreamState?.status === 'streaming' && !statusAutoLoadedRef.current) {
      statusAutoLoadedRef.current = true
      void refreshStatus()
    }
  }, [usbConnected, usbLogStreamState?.status])

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
      await refreshStatus()
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
    } catch (restartError) {
      setError(`Restart failed: ${errorDetail(restartError)}`)
    } finally {
      setRestartBusy(false)
    }
  }

  const factoryReset = async (): Promise<void> => {
    if (
      !window.confirm(
        `Factory reset "${frameName}"? This erases the device's Wi-Fi, backend and hardware settings and reboots it. This cannot be undone.`
      )
    ) {
      return
    }
    setFactoryResetBusy(true)
    setError(null)
    setMessage(null)
    try {
      await usbFactoryReset(frame.id)
      setStatus(null)
      setNetworks(null)
      setMessage('Factory reset complete. The device erased its settings and rebooted.')
    } catch (resetError) {
      setError(`Factory reset failed: ${errorDetail(resetError)}`)
    } finally {
      setFactoryResetBusy(false)
    }
  }

  const wifi = status?.wifi
  const config = status?.config

  return (
    <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
      <div>
        <div className="text-sm font-semibold text-[color:var(--tool-strong)]">USB setup</div>
        <div className="frame-tool-muted mt-1 text-sm leading-5">
          Provision the board over its USB serial console: check its status, join a Wi-Fi network, or reset it — no
          network connection needed.
        </div>
      </div>

      {!webSerialSupported ? (
        <div className="frame-tool-muted text-xs leading-5">
          USB setup needs Web Serial, which this browser doesn't support. Use Chrome or Edge.
        </div>
      ) : !usbConnected ? (
        <div className="flex flex-wrap items-center gap-3">
          <EmbeddedUsbConnectionButton frame={frame} />
          <span className="frame-tool-muted text-xs leading-4">Connect the board over USB to enable setup.</span>
        </div>
      ) : (
        <>
          <div className="frameos-inset space-y-1.5 rounded-xl border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">
                Device status
              </div>
              <button
                type="button"
                onClick={refreshStatus}
                disabled={busy}
                className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
              >
                {statusBusy ? <Spinner className="h-3.5 w-3.5" /> : <ArrowPathIcon className="h-3.5 w-3.5" />}
                Refresh
              </button>
            </div>
            {status ? (
              <div className="space-y-1">
                <StatusRow
                  label="Wi-Fi"
                  value={
                    config?.wifiSsid
                      ? `${config.wifiSsid} (${wifiStateLabel(wifi?.state)}${
                          wifi?.state === 2 && typeof wifi?.rssi === 'number' ? `, ${wifi.rssi} dBm` : ''
                        })`
                      : 'not configured'
                  }
                />
                <StatusRow label="IP address" value={wifi?.ip || '-'} />
                <StatusRow label="Backend" value={config?.backendUrl || status.cloud?.url || 'not configured'} />
                <StatusRow
                  label="Frame ID"
                  value={
                    config?.frameId !== undefined && config.frameId !== 0
                      ? String(config.frameId)
                      : status.cloud?.frameId || '-'
                  }
                />
                {status.version ? <StatusRow label="Firmware" value={status.version} /> : null}
              </div>
            ) : (
              <div className="frame-tool-muted text-sm leading-5">
                {statusBusy ? 'Reading device status over USB…' : 'Device status not read yet.'}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">
              Wi-Fi provisioning
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={scanNetworks}
                disabled={busy}
                className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
              >
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
              <button
                type="button"
                onClick={applyWifi}
                disabled={busy || !ssid.trim()}
                className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
              >
                {applyBusy ? <Spinner color="white" /> : <WifiIcon className="h-4 w-4" />}
                {applyBusy ? 'Applying' : 'Apply & restart'}
              </button>
            </div>
            <div className="frame-tool-muted text-xs leading-4">
              Saves the credentials over USB and restarts the device so it joins the network.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--tool-border)] pt-3">
            <button
              type="button"
              onClick={restartDevice}
              disabled={busy}
              className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
            >
              {restartBusy ? <Spinner /> : <ArrowPathIcon className="h-4 w-4" />}
              {restartBusy ? 'Restarting' : 'Restart device'}
            </button>
            <button
              type="button"
              onClick={factoryReset}
              disabled={busy}
              className="frameos-danger-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-40"
            >
              {factoryResetBusy ? <Spinner color="white" /> : <TrashIcon className="h-4 w-4" />}
              {factoryResetBusy ? 'Resetting' : 'Factory reset'}
            </button>
          </div>

          {message ? <div className="text-xs font-semibold text-green-600">{message}</div> : null}
          {error ? <div className="text-xs font-semibold text-red-500">{error}</div> : null}
        </>
      )}
    </div>
  )
}
