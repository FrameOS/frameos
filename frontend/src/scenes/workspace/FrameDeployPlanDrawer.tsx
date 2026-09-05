import { useActions, useMountedLogic, useValues } from 'kea'
import { AdvancedSection } from '../../components/AdvancedSection'
import { A as Link } from 'kea-router'
import clsx from 'clsx'
import copy from 'copy-to-clipboard'
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowsRightLeftIcon,
  ChevronRightIcon,
  CloudArrowDownIcon,
  CloudArrowUpIcon,
  ClipboardDocumentIcon,
  CommandLineIcon,
  CpuChipIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { useEffect, useState, type ReactNode } from 'react'
import { Checkbox } from '../../components/Checkbox'

import { DropdownMenu } from '../../components/DropdownMenu'
import { FrameConnectionDot } from '../../components/FrameConnectionDot'
import { PartialRefreshSettingsFields } from '../../components/PartialRefreshSettingsFields'
import { Spinner } from '../../components/Spinner'
import { Switch } from '../../components/Switch'
import { SshKeysSection } from '../../components/sshKeys/SshKeysSection'
import { TextInput } from '../../components/TextInput'
import { Tooltip } from '../../components/Tooltip'
import {
  formatFrameRelativeFuture,
  formatFrameRelativeTime,
  frameCheckin,
  frameHasActivityLog,
  frameHost,
} from '../../decorators/frame'
import {
  EMBEDDED_VIRTUAL,
  buildrootPlatforms,
  devices,
  normalizeBuildrootPlatform,
  partialRefreshDefaultsByDevice,
  partialRefreshDevices,
} from '../../devices'
import { framesModel, type RemoteTaskTransport } from '../../models/framesModel'
import {
  embeddedUsbApiCanUse,
  embeddedUsbLogsModel,
  isEmbeddedUsbLogStreamOpen,
} from '../../models/embeddedUsbLogsModel'
import type {
  FrameOSSettings,
  FrameSyncChoice,
  FrameSyncChange,
  FrameSyncSceneChoice,
  FrameSyncSection,
  FrameSyncStatus,
  FrameType,
  LogType,
  FrameId,
} from '../../types'
import { urls } from '../../urls'
import { apiFetch } from '../../utils/apiFetch'
import { secureToken } from '../../utils/secureToken'
import { Button } from '../../components/Button'
import { getDefaultSshKeyIds, normalizeSshKeys } from '../../utils/sshKeys'
import { normalizedTimezone } from '../../utils/timezone'
import {
  frameLogic,
  type ChangeDetail,
  type DeployDrawerView,
  type DeployRecommendation,
  type FrameSyncChoices,
  type SummaryItem,
  frameSyncChangeKey,
} from '../frame/frameLogic'
import { buildRemoteUpgradeNotice, frameosGitHubReleaseUrl, type RemoteUpgradeNotice } from '../frame/frameDeployUtils'
import { frameCompilationModeOptions } from '../../utils/frameBuildOptions'
import { logsLogic } from '../frame/panels/Logs/logsLogic'
import { settingsLogic } from '../settings/settingsLogic'
import {
  fetchReleaseFirmwareListing,
  hasReleaseFirmwarePlatform,
  releaseFirmwarePlatform,
  releaseFirmwarePlatformForFrame,
} from './EmbeddedUsbFirmwareUpdate'
import { registeredFramePanel } from './addFramePanelRegistry'
import { pushScenesOverUsb, pushedScenesMessage } from './embeddedUsbScenePush'
import { EmbeddedUsbConnect } from './EmbeddedUsbConnect'
import { EmbeddedUsbConnectionButton } from './embeddedFlashShared'
import { frameBootstrapLogic } from './frameBootstrapLogic'
import { framePendingCommandsLogic, pendingCommandLabel, type FramePendingCommand } from './framePendingCommandsLogic'
import { workspaceLogic } from './workspaceLogic'
import {
  frameMenuActionDisabledReason,
  frameMenuActionIsAllowed,
  isEsp32CloudFrame,
  workspaceMode,
} from './workspaceSurfaces'
import { timezoneOptions } from '../../decorators/timezones'

interface DeployPlanProgressStep {
  label: string
  detail?: string | null
  state: 'done' | 'current' | 'pending' | 'error'
}

function embeddedFlashSize(frame: FrameType): '2MB' | '4MB' | '8MB' | '16MB' | '32MB' {
  const raw = frame.embedded?.layout?.flash?.flashSize ?? frame.embedded?.flashSize ?? '8MB'
  const normalized = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\s+/g, '') : '8MB'
  return normalized === '2MB' ||
    normalized === '4MB' ||
    normalized === '8MB' ||
    normalized === '16MB' ||
    normalized === '32MB'
    ? normalized
    : '8MB'
}

function embeddedOtaSupported(frame: FrameType): boolean {
  const layoutSupport = frame.embedded?.layout?.flash?.otaSupported
  if (typeof layoutSupport === 'boolean') {
    return layoutSupport
  }
  const flashSize = embeddedFlashSize(frame)
  return flashSize !== '2MB' && flashSize !== '4MB'
}

function needsEsp32UsbJtagPortGuidance(frame: FrameType): boolean {
  const panel =
    frame.embedded?.layout?.ram?.panel || frame.embedded?.lastBoot?.panel || frame.device?.split('.').pop() || ''
  const hardwarePreset = frame.embedded?.hardwarePreset || frame.device_config?.hardwarePreset || ''
  return (
    panel === 'EPD_13in3e' ||
    hardwarePreset === 'waveshare_esp32_s3_epaper_13_3e6' ||
    frame.device === 'waveshare.EPD_13in3e'
  )
}

type EmbeddedFirmwareLayout = NonNullable<NonNullable<FrameType['embedded']>['layout']>
type EmbeddedFlashPartition = NonNullable<NonNullable<EmbeddedFirmwareLayout['flash']>['partitions']>[number]

function formatFirmwareBytes(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return 'not built'
  }
  if (bytes === 0) {
    return '0 B'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const mib = bytes / (1024 * 1024)
  if (mib >= 1) {
    return `${mib >= 10 ? mib.toFixed(1) : mib.toFixed(2)} MB`
  }
  return `${Math.round(bytes / 1024)} KB`
}

function formatFirmwareAddress(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-'
  }
  return `0x${Math.max(0, Math.round(value)).toString(16).toUpperCase().padStart(6, '0')}`
}

function percentOf(value: number | null | undefined, total: number | null | undefined): number {
  if (
    typeof value !== 'number' ||
    typeof total !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return 0
  }
  return Math.max(0, Math.min(100, (value / total) * 100))
}

function formatPercent(value: number | null | undefined, total: number | null | undefined): string {
  const percent = percentOf(value, total)
  return percent < 1 && percent > 0 ? '<1%' : `${Math.round(percent)}%`
}

function partitionColor(partition: EmbeddedFlashPartition, index: number): string {
  if (partition.name === 'bootloader' || partition.name === 'partition_table') {
    return '#64748b'
  }
  if (partition.type === 'data' && partition.subtype === 'nvs') {
    return '#0f766e'
  }
  if (partition.type === 'data' && partition.subtype === 'ota') {
    return '#7c3aed'
  }
  if (partition.type === 'data' && partition.subtype === 'phy') {
    return '#0369a1'
  }
  if (partition.type === 'data') {
    return '#b45309'
  }
  if (partition.appSlot) {
    return partition.name === 'ota_1' ? '#2563eb' : '#16a34a'
  }
  return ['#16a34a', '#2563eb', '#b45309', '#7c3aed'][index % 4]
}

function FirmwareStat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="frame-tool-muted text-[11px] font-semibold uppercase tracking-wide">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-[color:var(--tool-strong)]">{value}</div>
      {detail ? <div className="frame-tool-muted mt-0.5 truncate text-xs">{detail}</div> : null}
    </div>
  )
}

function FirmwareFootprintVisualization({ frame }: { frame: FrameType }): JSX.Element | null {
  const layout = frame.embedded?.layout
  const flash = layout?.flash
  const ram = layout?.ram
  const partitions = flash?.partitions ?? []
  const flashBytes = flash?.flashBytes ?? 0
  const otaSupported = flash?.otaSupported ?? embeddedOtaSupported(frame)
  const psramBytes = ram?.psramBytes ?? 0
  const renderWorkingBytes = ram?.renderWorkingBytes ?? 0
  const renderSpareBytes = psramBytes > renderWorkingBytes ? psramBytes - renderWorkingBytes : 0
  const ramSegments = [
    { label: 'Render canvas', bytes: ram?.canvasBufferBytes ?? ram?.rgbaBufferBytes ?? 0, color: '#2563eb' },
    { label: 'Packed panel', bytes: ram?.packedBufferBytes ?? 0, color: '#16a34a' },
    { label: 'Reserve', bytes: ram?.renderReserveBytes ?? 0, color: '#b45309' },
    { label: 'Spare', bytes: renderSpareBytes, color: '#e2e8f0' },
  ].filter((segment) => segment.bytes > 0)

  return (
    <div className="frame-tool-card space-y-5 rounded-[22px] p-4">
      <div>
        <div className="text-sm font-semibold text-[color:var(--tool-strong)]">Firmware footprint</div>
        {!flash && !ram ? (
          <div className="frame-tool-muted mt-1 text-sm leading-5">
            Waiting for firmware layout metadata from the backend.
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FirmwareStat
          label="Flash profile"
          value={flash?.flashSize ?? embeddedFlashSize(frame)}
          detail={otaSupported ? 'OTA A/B slots' : 'single app slot'}
        />
        <FirmwareStat
          label="Partition table"
          value={flash?.partitionTable ?? '—'}
          detail={flashBytes ? `${formatFirmwareBytes(flashBytes)} flash` : 'from the release image'}
        />
        <FirmwareStat
          label="Firmware"
          value="Release image"
          detail={otaSupported ? 'updated over the air' : 'updated over USB'}
        />
      </div>

      {partitions.length > 0 && flashBytes > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">
              Flash partitions
            </div>
            <div className="frame-tool-muted truncate text-xs">
              {flash?.partitionTable} · {formatFirmwareBytes(flashBytes)}
            </div>
          </div>
          <div className="frameos-inset flex h-9 overflow-hidden rounded-lg border">
            {partitions.map((partition, index) => {
              const width = percentOf(partition.size, flashBytes)
              return (
                <div
                  key={`${partition.name}-${partition.offset}`}
                  title={`${partition.name}: ${formatFirmwareAddress(partition.offset)} - ${formatFirmwareBytes(
                    partition.size
                  )}`}
                  className="relative min-w-[2px] border-r border-white/60 last:border-r-0"
                  style={{ width: `${width}%`, backgroundColor: partitionColor(partition, index) }}
                >
                  {width >= 9 ? (
                    <span className="absolute inset-x-1 top-1/2 -translate-y-1/2 truncate text-center text-[10px] font-semibold text-white">
                      {partition.name}
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-3 gap-y-1 text-xs">
            <div className="frame-tool-muted font-semibold">Partition</div>
            <div className="frame-tool-muted text-right font-semibold">Offset</div>
            <div className="frame-tool-muted text-right font-semibold">Size</div>
            <div className="frame-tool-muted text-right font-semibold">Used</div>
            {partitions.map((partition, index) => (
              <div key={`${partition.name}-${partition.offset}-row`} className="contents">
                <div className="min-w-0 truncate text-[color:var(--tool-strong)]">
                  <span
                    className="mr-2 inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: partitionColor(partition, index) }}
                  />
                  {partition.name}
                </div>
                <div className="text-right text-[color:var(--tool-strong)]">
                  {formatFirmwareAddress(partition.offset)}
                </div>
                <div className="text-right text-[color:var(--tool-strong)]">{formatFirmwareBytes(partition.size)}</div>
                <div className="text-right text-[color:var(--tool-strong)]">
                  {partition.usedBytes ? formatFirmwareBytes(partition.usedBytes) : '-'}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {ram ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">
              PSRAM buffers
            </div>
            <div className="frame-tool-muted truncate text-xs">
              {ram.panel ?? frame.device} · {ram.width || '?'}x{ram.height || '?'} · {ram.pixelFormatName}
            </div>
          </div>
          {psramBytes > 0 && ramSegments.length > 0 ? (
            <div className="frameos-inset flex h-9 overflow-hidden rounded-lg border">
              {ramSegments.map((segment) => (
                <div
                  key={segment.label}
                  title={`${segment.label}: ${formatFirmwareBytes(segment.bytes)}`}
                  className={clsx(
                    'relative min-w-[2px] border-r border-white/60 last:border-r-0',
                    segment.label === 'Spare' ? 'text-slate-700' : 'text-white'
                  )}
                  style={{ width: `${percentOf(segment.bytes, psramBytes)}%`, backgroundColor: segment.color }}
                >
                  {percentOf(segment.bytes, psramBytes) >= 10 ? (
                    <span className="absolute inset-x-1 top-1/2 -translate-y-1/2 truncate text-center text-[10px] font-semibold">
                      {segment.label}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <FirmwareStat
              label="Render working set"
              value={formatFirmwareBytes(renderWorkingBytes)}
              detail={`${formatPercent(renderWorkingBytes, psramBytes)} of ${formatFirmwareBytes(psramBytes)} PSRAM`}
            />
            <FirmwareStat
              label="Packed snapshot"
              value={formatFirmwareBytes(ram.previewSnapshotBytes)}
              detail={`kept only with ${formatFirmwareBytes(ram.previewSnapshotReserveBytes)} spare`}
            />
            <FirmwareStat
              label="HTTP / USB BMP"
              value={formatFirmwareBytes(ram.previewBmpBytes)}
              detail="allocated only while serving image preview"
            />
            <FirmwareStat
              label="Scene JS heap cap"
              value={formatFirmwareBytes(ram.quickJsHeapLimitBytes)}
              detail={`hash state is ${formatFirmwareBytes(ram.displayStateBytes)}`}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function parseDeployPlanLogTimestamp(timestamp?: string | null): number {
  if (!timestamp) {
    return NaN
  }
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
  return Date.parse(hasTimeZone ? timestamp : `${timestamp}Z`)
}

function cleanDeployPlanLogLine(line: string): string {
  return line
    .replace(/^[^\w>\-./]+/u, '')
    .replace(/^>\s*/, '')
    .trim()
}

function deployPlanLogsSince(logs: LogType[], startedAt: string | null): LogType[] {
  if (!startedAt) {
    return []
  }
  const startedAtMs = parseDeployPlanLogTimestamp(startedAt)
  if (!Number.isFinite(startedAtMs)) {
    return []
  }
  return logs.filter((log) => {
    const logMs = parseDeployPlanLogTimestamp(log.timestamp)
    return Number.isFinite(logMs) && logMs >= startedAtMs - 1500
  })
}

function lastLogMatching(logs: LogType[], predicate: (line: string) => boolean): LogType | null {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (predicate(logs[index].line)) {
      return logs[index]
    }
  }
  return null
}

function deployPlanProgressSteps({
  error,
  loading,
  logs,
  planReady,
}: {
  error?: string | null
  loading: boolean
  logs: LogType[]
  planReady: boolean
}): DeployPlanProgressStep[] {
  const connectStartedLog = lastLogMatching(logs, (line) => line.includes('Connecting via SSH'))
  const connectedLog = lastLogMatching(logs, (line) => line.includes('SSH connection established'))
  const commandLog = lastLogMatching(logs, (line) => line.trim().startsWith('>'))
  const detectedLog = lastLogMatching(logs, (line) => line.includes('Detected distro'))
  const prebuiltLog = lastLogMatching(logs, (line) => line.toLowerCase().includes('prebuilt'))
  const deviceSignalLog = commandLog || detectedLog || prebuiltLog
  const connected = Boolean(connectedLog || deviceSignalLog)
  const inspected = Boolean(detectedLog || prebuiltLog)
  const strategyChecked = Boolean(prebuiltLog)

  return [
    {
      label: connected ? 'Connected to frame' : 'Connecting to frame',
      detail: connected ? null : connectStartedLog?.line ?? null,
      state: connected ? 'done' : error ? 'error' : 'current',
    },
    {
      label: 'Gathering device data',
      detail: null,
      state: inspected ? 'done' : connected ? (error ? 'error' : 'current') : 'pending',
    },
    {
      label: 'Checking build strategy',
      detail: null,
      state: strategyChecked ? 'done' : inspected ? (error ? 'error' : 'current') : 'pending',
    },
    {
      label: planReady ? 'Deploy options ready' : 'Preparing deploy options',
      detail: planReady ? 'Choose fast or full deploy below.' : error || null,
      state: error ? 'error' : planReady ? 'done' : loading && strategyChecked ? 'current' : 'pending',
    },
  ]
}

function formatDeployPlanLogTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function effectiveSshKeyIds(frame: FrameType, frameForm: Partial<FrameType>, settings: FrameOSSettings): string[] {
  if (frameForm.ssh_keys !== undefined) {
    return frameForm.ssh_keys ?? []
  }
  if (frame.ssh_keys !== undefined && frame.ssh_keys !== null) {
    return frame.ssh_keys
  }

  const defaultIds = getDefaultSshKeyIds(settings.ssh_keys)
  if (defaultIds.length > 0) {
    return defaultIds
  }
  return normalizeSshKeys(settings.ssh_keys).keys.map((key) => key.id)
}

function deployPlanLogTone(
  log: LogType,
  line: string,
  theme: 'light' | 'dark'
): { dot: string; timestamp: string; text: string } {
  const lowerLine = line.toLowerCase()

  if (
    log.type === 'stderr' ||
    lowerLine.includes('error') ||
    lowerLine.includes('failed') ||
    lowerLine.includes('traceback')
  ) {
    return theme === 'dark'
      ? { dot: 'bg-red-400', timestamp: 'text-red-300/80', text: 'text-red-300' }
      : { dot: 'bg-red-500', timestamp: 'text-red-600/80', text: 'text-red-700' }
  }

  if (lowerLine.includes('warn') || lowerLine.includes('retry')) {
    return theme === 'dark'
      ? { dot: 'bg-amber-300', timestamp: 'text-amber-200/80', text: 'text-yellow-300' }
      : { dot: 'bg-amber-500', timestamp: 'text-amber-600/80', text: 'text-amber-700' }
  }

  if (log.type === 'stdinfo' || log.type === 'build') {
    return theme === 'dark'
      ? { dot: 'bg-amber-300', timestamp: 'text-amber-200/80', text: 'text-yellow-300' }
      : { dot: 'bg-amber-500', timestamp: 'text-amber-600/80', text: 'text-amber-700' }
  }

  if (log.type === 'agent' || log.type === 'remote') {
    return theme === 'dark'
      ? { dot: 'bg-blue-300', timestamp: 'text-blue-200/80', text: 'text-blue-300' }
      : { dot: 'bg-blue-500', timestamp: 'text-blue-600/80', text: 'frameos-primary-text' }
  }

  return theme === 'dark'
    ? { dot: 'bg-slate-500', timestamp: 'text-slate-500', text: 'text-slate-100' }
    : { dot: 'bg-slate-400', timestamp: 'text-slate-500', text: 'text-slate-900' }
}

function SystemLogsDisclosure({ logs }: { logs: LogType[] }): JSX.Element {
  const { theme } = useValues(workspaceLogic)
  const visibleLogs = logs.filter((log) => log.line.trim()).slice(-80)

  return (
    <details className="group">
      <summary className="frame-tool-heading flex cursor-pointer list-none items-center gap-2 text-xs font-semibold uppercase tracking-wide marker:hidden">
        <ChevronRightIcon className="h-4 w-4 shrink-0 transition group-open:rotate-90" />
        <span className="flex-1">System logs</span>
        <span className="frame-tool-muted text-[11px] font-semibold normal-case tracking-normal">
          {visibleLogs.length} lines
        </span>
      </summary>
      <div className="mt-2 max-h-72 overflow-y-auto font-mono text-xs leading-5">
        {visibleLogs.length === 0 ? (
          <div className="py-6 text-center text-slate-500">Waiting for logs...</div>
        ) : (
          visibleLogs.map((log) => {
            const line = cleanDeployPlanLogLine(log.line)
            const tone = deployPlanLogTone(log, line, theme)

            return (
              <div key={`${log.id}-${log.timestamp}`} className="flex gap-2">
                <span className={clsx('mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />
                <span className={clsx('shrink-0', tone.timestamp)}>{formatDeployPlanLogTimestamp(log.timestamp)}</span>
                <span className={clsx('min-w-0 break-words', tone.text)}>{line}</span>
              </div>
            )
          })
        )}
      </div>
    </details>
  )
}

function DeployPlanProgress({
  error,
  logs,
  planReady,
}: {
  error?: string | null
  logs: LogType[]
  planReady: boolean
}): JSX.Element {
  const steps = deployPlanProgressSteps({ error, loading: !planReady && !error, logs, planReady })

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {steps.map((step) => (
          <div key={step.label} className="flex gap-3 text-sm">
            {step.state === 'current' ? (
              <Spinner className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" />
            ) : (
              <span
                className={clsx(
                  'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full',
                  step.state === 'done' ? 'bg-emerald-400' : step.state === 'error' ? 'bg-red-400' : 'bg-slate-300/70'
                )}
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-[color:var(--tool-strong)]">{step.label}</span>
              {step.detail ? (
                <span className="frame-tool-muted mt-0.5 block truncate text-xs">{step.detail}</span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <div className="frameos-divider border-t border-slate-200/80 pt-4">
        <SystemLogsDisclosure logs={logs} />
      </div>
    </div>
  )
}

function SummaryRows({ items }: { items: SummaryItem[] }): JSX.Element | null {
  if (items.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={`${item.label}:${item.value}`} className="rounded-xl bg-slate-500/10 px-3 py-2 text-sm">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{item.label}</div>
          <div className="mt-0.5 text-[color:var(--tool-strong)]">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function DeployBuildOptionsSection({
  frame,
  frameForm,
}: {
  frame: FrameType
  frameForm: Partial<FrameType>
}): JSX.Element | null {
  const { setFrameFormValues, touchFrameFormField } = useActions(frameLogic({ frameId: frame.id }))
  const mode = frameForm.mode ?? frame.mode ?? 'rpios'
  if (mode === 'embedded') {
    return null
  }
  const isBuildroot = mode === 'buildroot'
  const rpios = {
    ...(frame.rpios ?? {}),
    ...(frameForm.rpios ?? {}),
  }
  const buildroot = {
    ...(frame.buildroot ?? {}),
    ...(frameForm.buildroot ?? {}),
  }
  const compilationMode = String((isBuildroot ? buildroot.compilationMode : rpios.compilationMode) ?? '')
  const selectClassName =
    'frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30'

  const updateRpios = (field: keyof NonNullable<FrameType['rpios']>, value: string): void => {
    const nextRpios = { ...rpios, [field]: value }
    delete nextRpios.crossCompilation
    setFrameFormValues({ rpios: nextRpios })
    touchFrameFormField(`rpios.${field}`)
  }

  const updateBuildroot = (field: keyof NonNullable<FrameType['buildroot']>, value: string): void => {
    setFrameFormValues({ buildroot: { ...buildroot, [field]: value } })
    touchFrameFormField(`buildroot.${field}`)
  }

  return (
    <section className="space-y-2">
      <AdvancedSection label="advanced: installation mode" open={compilationMode === 'static'}>
        <DrawerHeading action={<FrameSettingsLink frameId={frame.id} />}>Installation mode</DrawerHeading>
        <label className="block space-y-1">
          <select
            className={selectClassName}
            value={compilationMode}
            onChange={(event) =>
              isBuildroot
                ? updateBuildroot('compilationMode', event.target.value)
                : updateRpios('compilationMode', event.target.value)
            }
          >
            {frameCompilationModeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </AdvancedSection>
    </section>
  )
}

function FrameosReleaseLink({ version }: { version: string }): JSX.Element {
  return (
    <a
      href={frameosGitHubReleaseUrl(version)}
      target="_blank"
      rel="noreferrer noopener"
      className="frameos-link font-semibold underline underline-offset-2 hover:no-underline"
      title={`View FrameOS ${version} release on GitHub`}
    >
      {version}
    </a>
  )
}

function ChangeLabel({ change }: { change: ChangeDetail }): JSX.Element {
  const frameosVersionChange = change.frameosVersionChange
  const remoteVersionChange = change.remoteVersionChange
  if (!frameosVersionChange && !remoteVersionChange) {
    return <>{change.label}</>
  }

  if (remoteVersionChange) {
    return (
      <>
        FrameOS Remote{' '}
        {remoteVersionChange.previousVersion ? (
          <FrameosReleaseLink version={remoteVersionChange.previousVersion} />
        ) : (
          'unreported'
        )}{' '}
        -&gt; <FrameosReleaseLink version={remoteVersionChange.currentVersion} />
      </>
    )
  }

  if (!frameosVersionChange) {
    return <>{change.label}</>
  }

  if (frameosVersionChange.kind === 'install') {
    return (
      <>
        Install FrameOS <FrameosReleaseLink version={frameosVersionChange.currentVersion} />
      </>
    )
  }

  return (
    <>
      FrameOS{' '}
      {frameosVersionChange.previousVersion ? (
        <FrameosReleaseLink version={frameosVersionChange.previousVersion} />
      ) : (
        'unreported'
      )}{' '}
      -&gt; <FrameosReleaseLink version={frameosVersionChange.currentVersion} />
    </>
  )
}

function ChangeRows({ changes }: { changes: ChangeDetail[] }): JSX.Element | null {
  if (changes.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      {changes.map((change) => (
        <div key={`${change.label}:${change.requiresFullDeploy}`} className="flex items-center gap-2 text-sm">
          <span
            className={clsx(
              'h-2.5 w-2.5 shrink-0 rounded-full',
              change.requiresFullDeploy ? 'bg-[color:var(--frameos-color-brass)]' : 'frameos-primary-fill'
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[color:var(--tool-strong)]">
            <ChangeLabel change={change} />
          </span>
          <span className="frame-tool-muted shrink-0 text-xs">{change.requiresFullDeploy ? 'Full' : 'Fast'}</span>
        </div>
      ))}
    </div>
  )
}

function DrawerHeading({ action, children }: { action?: JSX.Element; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="frame-tool-heading text-sm font-semibold">{children}</div>
      {action}
    </div>
  )
}

/**
 * What is still waiting for the frame to wake up and take it.
 *
 * A cloud frame's actions are queued, not applied — the reboot, the render,
 * the scene push and the firmware notification all sit in the account's
 * command queue until the device connects. On a battery ESP32 that sleeps for
 * hours, that made "sent" and "done" indistinguishable in the workspace. This
 * lists the queue, says how long each entry has left, and lets the owner take
 * one back off it while it is still undelivered.
 *
 * Renders nothing when the queue is empty, which is also what a control plane
 * without a queue looks like (the loader turns any non-200 into an empty
 * list), so it is safe to mount on every deploy drawer.
 */
function PendingActionsSection({ frame, className }: { frame: FrameType; className?: string }): JSX.Element | null {
  const logic = framePendingCommandsLogic({ frameId: frame.id })
  const { pendingCommands, pendingCommandsError, cancellingCommandIds } = useValues(logic)
  const { cancelPendingCommand, loadPendingCommands } = useActions(logic)

  if (pendingCommands.length === 0) {
    return null
  }

  const checkin = frameCheckin(frame)
  const queueNote =
    frame.connected === false
      ? checkin?.kind === 'sleeping'
        ? `Queued on the account. The frame is asleep and applies these when it wakes ${formatFrameRelativeFuture(
            checkin.wakeAt,
            Date.now(),
            checkin.announced ? '' : '~'
          )}.`
        : checkin?.kind === 'overdue'
        ? `Queued on the account. The frame was expected back ${formatFrameRelativeTime(
            checkin.wakeAt
          )} and has not reconnected — these apply when it does.`
        : 'Queued on the account. The frame applies these the next time it connects.'
      : 'Queued on the account and being delivered now.'

  return (
    <section className={clsx('space-y-2', className)}>
      <DrawerHeading
        action={
          <button
            type="button"
            onClick={() => loadPendingCommands()}
            className="frameos-secondary-button rounded-lg px-2.5 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Refresh
          </button>
        }
      >
        Waiting for the frame
      </DrawerHeading>
      <div className="frame-tool-card space-y-2 rounded-[22px] p-4">
        <div className="frame-tool-muted text-xs leading-5">{queueNote}</div>
        {pendingCommands.map((command) => {
          const cancelling = cancellingCommandIds.includes(command.id)
          return (
            <div
              key={command.id}
              data-testid="pending-command-row"
              className="flex items-start justify-between gap-3 border-t border-slate-200/70 pt-2 first-of-type:border-0 first-of-type:pt-0"
            >
              <div className="min-w-0">
                <div className="frame-tool-heading text-sm font-semibold">{pendingCommandLabel(command)}</div>
                <div className="frame-tool-muted text-xs leading-5">{pendingCommandDetail(command)}</div>
              </div>
              <button
                type="button"
                disabled={cancelling}
                onClick={() => cancelPendingCommand(command.id)}
                className="frameos-secondary-button shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
              >
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          )
        })}
        {pendingCommandsError ? <div className="text-xs font-semibold text-red-500">{pendingCommandsError}</div> : null}
      </div>
    </section>
  )
}

// "Queued 3 minutes ago · expires in 4 minutes". The expiry matters more than
// it looks: "now" commands (render, reboot) are deliberately short-lived so a
// reboot queued on Monday cannot fire on Friday, and a frame that sleeps
// longer than the TTL will simply never see them.
function pendingCommandDetail(command: FramePendingCommand): string {
  const parts: string[] = []
  const queued = formatFrameRelativeTime(command.created_at)
  parts.push(
    command.status === 'sent' ? 'Delivered, waiting for the frame to confirm' : `Queued ${queued ?? 'just now'}`
  )
  const expiresAt = command.expires_at ? Date.parse(command.expires_at) : Number.NaN
  if (Number.isFinite(expiresAt)) {
    const minutes = Math.round((expiresAt - Date.now()) / 60000)
    parts.push(
      minutes <= 0
        ? 'expiring now'
        : minutes < 60
        ? `expires in ${minutes} minute${minutes === 1 ? '' : 's'}`
        : `expires in ${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'}`
    )
  }
  if (command.detail) {
    parts.push(command.detail)
  }
  return parts.join(' · ')
}

function BackToDeployButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      Back
    </button>
  )
}

function FrameSettingsLink({ frameId }: { frameId: FrameId }): JSX.Element {
  return (
    <Link
      href={urls.frame(frameId, 'settings')}
      className="frameos-link text-xs font-semibold underline underline-offset-2 hover:no-underline"
    >
      See all settings
    </Link>
  )
}

function AlternativesSection({
  onSelect,
  title = 'Alternatives',
}: {
  onSelect: (view: DeployDrawerView) => void
  title?: string
}): JSX.Element {
  return (
    <section className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="frame-tool-heading text-sm font-semibold">{title}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onSelect('sdCard')}
            className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <ArrowDownTrayIcon className="h-4 w-4" />
            Download SD card
          </button>
          <button
            type="button"
            onClick={() => onSelect('script')}
            className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <CommandLineIcon className="h-4 w-4" />
            Run a script
          </button>
        </div>
      </div>
    </section>
  )
}

function RecommendationDescription({ recommendation }: { recommendation: DeployRecommendation }): JSX.Element {
  const emphasis = recommendation.descriptionEmphasis
  if (!emphasis || !recommendation.description.includes(emphasis)) {
    return <>{recommendation.description}</>
  }

  const [before, after] = recommendation.description.split(emphasis)
  return (
    <>
      {before}
      <strong className="font-semibold text-[color:var(--tool-strong)]">{emphasis}</strong>
      {after}
    </>
  )
}

function remoteUpgradeLabel(notice: RemoteUpgradeNotice): string {
  return `${notice.previousVersion ?? 'unreported'} to ${notice.currentVersion}`
}

function RemoteUpgradeIndicator({ notice }: { notice: RemoteUpgradeNotice }): JSX.Element {
  return (
    <ExclamationCircleIcon
      className="h-4 w-4 text-amber-500"
      aria-label={`FrameOS Remote ${remoteUpgradeLabel(notice)}`}
    />
  )
}

function DeployRemoteLabel({ notice }: { notice: RemoteUpgradeNotice | null }): JSX.Element {
  if (!notice) {
    return <>Deploy Remote</>
  }

  return (
    <span className="min-w-0">
      <span>Deploy Remote</span>{' '}
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600">
        <RemoteUpgradeIndicator notice={notice} />
        <span>{remoteUpgradeLabel(notice)}</span>
      </span>
    </span>
  )
}

function DeployTransportToggle({
  frameId,
  remoteConnected,
  remoteUpgradeNotice,
  canDeployRemote,
  canCopyBootstrapScript,
  showRecompileRemote,
  onDeployRemote,
  onRestartRemote,
  deployWithAgent,
  onChange,
}: {
  frameId: FrameId
  remoteConnected: boolean
  remoteUpgradeNotice: RemoteUpgradeNotice | null
  canDeployRemote: boolean
  canCopyBootstrapScript: boolean
  showRecompileRemote: boolean
  onDeployRemote: (recompile?: boolean, transport?: RemoteTaskTransport) => void
  onRestartRemote: (transport?: RemoteTaskTransport) => void
  deployWithAgent: boolean
  onChange: (deployWithAgent: boolean) => void
}): JSX.Element {
  const bootstrapLogicProps = { frameId }
  const { copied: bootstrapCopied, loading: bootstrapLoading } = useValues(frameBootstrapLogic(bootstrapLogicProps))
  const { copyFrameBootstrapScript } = useActions(frameBootstrapLogic(bootstrapLogicProps))
  const selectedTransport: RemoteTaskTransport = deployWithAgent ? 'remote' : 'ssh'
  const selectedConnectionLabel = deployWithAgent ? 'FrameOS Remote' : 'SSH'
  const selectedRemoteDisconnected = selectedTransport === 'remote' && !remoteConnected
  const selectedConnectionUnavailableTitle = 'FrameOS Remote is not connected. Select SSH or wait for it to connect.'
  const selectedConnectionTitle = `Use the selected ${selectedConnectionLabel} connection`
  const remoteUpgradeTitle = remoteUpgradeNotice
    ? `FrameOS Remote ${remoteUpgradeLabel(remoteUpgradeNotice)}`
    : undefined

  return (
    <section className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="frame-tool-heading text-sm font-semibold">Connect via</div>
          <Tooltip
            className="inline-flex h-5 w-5 items-center justify-center rounded-full"
            titleClassName="w-72"
            title={
              <div className="space-y-1">
                <div>
                  Without FrameOS Remote the backend reaches the frame directly on your network: SSH for deploys and
                  commands, HTTP to the frame's web server for screenshots and events. FrameOS Remote instead runs on
                  the frame and keeps a connection open to the backend, so neither needs a route in.
                </div>
                <div>
                  To use FrameOS Remote, enable it under{' '}
                  <Link
                    href={`${urls.frame(frameId, 'settings')}#frame-settings-agent`}
                    className="frameos-link underline underline-offset-2 hover:no-underline"
                  >
                    Settings
                  </Link>
                  {', '}
                  and either run the bootstrap script (curl) on the frame, or deploy it over SSH.
                </div>
              </div>
            }
          >
            <ExclamationCircleIcon className="h-4 w-4" aria-label="Connection options help" />
          </Tooltip>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex items-center gap-2">
            <button
              type="button"
              aria-pressed={!deployWithAgent}
              onClick={() => onChange(false)}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                !deployWithAgent ? 'frameos-primary-action' : 'frameos-secondary-button'
              )}
            >
              SSH
            </button>
            <button
              type="button"
              aria-pressed={deployWithAgent}
              title={remoteConnected ? 'FrameOS Remote connected' : 'FrameOS Remote not connected'}
              onClick={() => onChange(true)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                deployWithAgent ? 'frameos-primary-action' : 'frameos-secondary-button'
              )}
            >
              {remoteConnected ? (
                <FrameConnectionDot size="sm" title="FrameOS Remote connected" />
              ) : (
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full bg-slate-300 ring-1 ring-inset ring-slate-400/50"
                />
              )}
              <span>Remote</span>
            </button>
          </div>
          <DropdownMenu
            buttonColor="none"
            horizontal
            className="frameos-secondary-button flex h-9 w-9 items-center justify-center rounded-xl !px-0 !py-0 !shadow-none transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            buttonAdornment={
              remoteUpgradeNotice ? (
                <span title={remoteUpgradeTitle}>
                  <RemoteUpgradeIndicator notice={remoteUpgradeNotice} />
                </span>
              ) : undefined
            }
            items={[
              ...(canCopyBootstrapScript
                ? [
                    {
                      label: bootstrapCopied ? 'Bootstrap copied' : 'Copy bootstrap command',
                      title: 'Copy FrameOS bootstrap install command',
                      loading: bootstrapLoading,
                      onClick: () => copyFrameBootstrapScript(false),
                    },
                  ]
                : []),
              {
                label: 'Restart Remote',
                title: selectedRemoteDisconnected ? selectedConnectionUnavailableTitle : selectedConnectionTitle,
                disabled: selectedRemoteDisconnected,
                onClick: () => onRestartRemote(selectedTransport),
              },
              ...(canDeployRemote
                ? [
                    {
                      label: <DeployRemoteLabel notice={remoteUpgradeNotice} />,
                      title: selectedRemoteDisconnected
                        ? selectedConnectionUnavailableTitle
                        : remoteUpgradeTitle ?? selectedConnectionTitle,
                      disabled: selectedRemoteDisconnected,
                      onClick: () => onDeployRemote(false, selectedTransport),
                    },
                    ...(showRecompileRemote
                      ? [
                          {
                            label: 'Recompile and deploy Remote',
                            title: selectedRemoteDisconnected
                              ? selectedConnectionUnavailableTitle
                              : selectedConnectionTitle,
                            disabled: selectedRemoteDisconnected,
                            onClick: () => onDeployRemote(true, selectedTransport),
                          },
                        ]
                      : []),
                  ]
                : []),
            ]}
          />
        </div>
      </div>
    </section>
  )
}

function FrameBootstrapHelp(): JSX.Element {
  return (
    <Tooltip
      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-amber-500 hover:text-amber-600"
      titleClassName="w-72"
      title="Use this when the frame can reach this backend but SSH is unavailable. Run the command on the frame as root to install FrameOS and connect FrameOS Remote."
    >
      <ExclamationCircleIcon className="h-4 w-4" aria-label="FrameOS bootstrap help" />
    </Tooltip>
  )
}

function FrameBootstrapAction({ frame }: { frame: FrameType }): JSX.Element | null {
  const logicProps = { frameId: frame.id }
  const { copied, error, loading } = useValues(frameBootstrapLogic(logicProps))
  const { copyFrameBootstrapScript } = useActions(frameBootstrapLogic(logicProps))

  if (frame.last_successful_deploy_at || (frame.mode ?? 'rpios') !== 'rpios') {
    return null
  }

  return (
    <section className="space-y-2">
      <DrawerHeading>
        <span className="inline-flex items-center gap-1.5">
          <span>FrameOS bootstrap</span>
          <FrameBootstrapHelp />
        </span>
      </DrawerHeading>
      <button
        type="button"
        onClick={() => copyFrameBootstrapScript()}
        disabled={loading}
        className="frameos-secondary-button flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ClipboardDocumentIcon className="h-5 w-5 shrink-0" />
          <span className="truncate">
            {copied ? 'FrameOS bootstrap script copied' : 'Copy FrameOS bootstrap script'}
          </span>
        </span>
        {loading ? <Spinner className="shrink-0" /> : null}
      </button>
      {error ? <div className="text-sm font-semibold text-red-500">{error}</div> : null}
    </section>
  )
}

function BuildrootSdCardSection({
  frame,
  frameForm,
  onBack,
  onDownload,
  defaultTimezone,
}: {
  frame: FrameType
  frameForm: Partial<FrameType>
  onBack?: () => void
  onDownload: () => void
  defaultTimezone?: string | null
}): JSX.Element {
  const { setFrameFormValues, touchFrameFormField } = useActions(frameLogic({ frameId: frame.id }))
  const { savedSettings } = useValues(settingsLogic)
  const network = frameForm.network ?? frame.network ?? {}
  const buildroot = frameForm.buildroot ?? frame.buildroot ?? {}
  const serverHost = frameForm.server_host ?? frame.server_host ?? ''
  const serverPort = frameForm.server_port ?? frame.server_port ?? 8989
  const device = frameForm.device ?? frame.device ?? 'web_only'
  const deviceConfig = frameForm.device_config ?? frame.device_config ?? {}
  const timezone = normalizedTimezone(frameForm.timezone ?? frame.timezone, defaultTimezone)
  const platform = normalizeBuildrootPlatform(buildroot.platform)
  const compilationMode = String(buildroot.compilationMode ?? '')
  const rootPassword = frameForm.ssh_pass ?? frame.ssh_pass ?? ''
  const selectedSshKeys = new Set(effectiveSshKeyIds(frame, frameForm, savedSettings))
  const updateFrameValue = <K extends keyof FrameType>(field: K, value: FrameType[K]): void => {
    setFrameFormValues({ [field]: value } as Partial<FrameType>)
    touchFrameFormField(String(field))
  }
  const updateNetwork = (field: keyof NonNullable<FrameType['network']>, value: string): void => {
    setFrameFormValues({ network: { ...network, [field]: value } })
    touchFrameFormField(`network.${field}`)
  }
  const updateBuildroot = (field: keyof NonNullable<FrameType['buildroot']>, value: string): void => {
    setFrameFormValues({ buildroot: { ...buildroot, [field]: value } })
    touchFrameFormField(`buildroot.${field}`)
  }
  const updateDeviceConfig = (nextDeviceConfig: NonNullable<FrameType['device_config']>): void => {
    setFrameFormValues({ device_config: nextDeviceConfig })
    touchFrameFormField('device_config')
  }
  const uploadHeaders = Array.isArray(deviceConfig.uploadHeaders)
    ? deviceConfig.uploadHeaders.map((header) => ({ name: header?.name ?? '', value: header?.value ?? '' }))
    : []
  const updateUploadHeader = (index: number, key: 'name' | 'value', value: string): void => {
    updateDeviceConfig({
      ...deviceConfig,
      uploadHeaders: uploadHeaders.map((header, idx) => (idx === index ? { ...header, [key]: value } : header)),
    })
  }

  return (
    <section className="mb-5 space-y-2">
      <DrawerHeading action={<FrameSettingsLink frameId={frame.id} />}>
        <span className="inline-flex items-center gap-2">
          {onBack ? <BackToDeployButton onClick={onBack} /> : null}
          <span>SD card</span>
        </span>
      </DrawerHeading>
      <div className="mb-3">
        <div className="frame-tool-muted mt-1 text-sm leading-5">
          Download a flashable SD card with FrameOS preinstalled.
        </div>
        {frame.buildroot?.sdImage?.status ? (
          <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">
            Status: {frame.buildroot.sdImage.status}
          </div>
        ) : null}
      </div>
      <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
        <div className="grid grid-cols-1 gap-3">
          <label className="block space-y-1">
            <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Backend host</span>
            <TextInput
              value={serverHost}
              onChange={(value) => updateFrameValue('server_host', value)}
              placeholder="192.168.1.10"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1">
            <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Backend port</span>
            <TextInput
              value={String(serverPort)}
              onChange={(value) => updateFrameValue('server_port', Number(value) || 8989)}
              placeholder="8989"
              type="number"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1">
            <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Driver</span>
            <select
              className="frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30"
              value={device}
              onChange={(event) => updateFrameValue('device', event.target.value)}
            >
              {devices.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((device) => (
                    <option key={device.value} value={device.value}>
                      {device.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {device === 'waveshare.EPD_10in3' ? (
            <label className="block space-y-1">
              <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">VCOM</span>
              <TextInput
                value={deviceConfig.vcom ?? ''}
                onChange={(value) => updateDeviceConfig({ ...deviceConfig, vcom: value })}
                placeholder="-1.48"
              />
            </label>
          ) : null}
          {partialRefreshDevices.has(device) ? (
            <PartialRefreshSettingsFields
              value={deviceConfig}
              onChange={updateDeviceConfig}
              variant="panel"
              panelDefaults={partialRefreshDefaultsByDevice[device]}
            />
          ) : null}
          {device === 'http.upload' ? (
            <>
              <label className="block space-y-1">
                <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Upload URL</span>
                <TextInput
                  value={deviceConfig.uploadUrl ?? ''}
                  onChange={(value) => updateDeviceConfig({ ...deviceConfig, uploadUrl: value })}
                  placeholder="https://example.com/upload"
                />
              </label>
              <div className="space-y-2">
                <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">HTTP headers</div>
                {uploadHeaders.map((header, index) => (
                  <div key={index} className="grid grid-cols-1 gap-2">
                    <TextInput
                      value={header.name}
                      onChange={(value) => updateUploadHeader(index, 'name', value)}
                      placeholder="Header name"
                    />
                    <TextInput
                      value={header.value}
                      onChange={(value) => updateUploadHeader(index, 'value', value)}
                      placeholder="Header value"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        updateDeviceConfig({
                          ...deviceConfig,
                          uploadHeaders: uploadHeaders.filter((_, idx) => idx !== index),
                        })
                      }
                      className="frameos-secondary-button h-10 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                    >
                      Remove header
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    updateDeviceConfig({
                      ...deviceConfig,
                      uploadHeaders: [...uploadHeaders, { name: '', value: '' }],
                    })
                  }
                  className="frameos-secondary-button h-10 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  Add header
                </button>
              </div>
            </>
          ) : null}
          <label className="block space-y-1">
            <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Timezone</span>
            <select
              className="frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30"
              value={timezone}
              onChange={(event) => updateFrameValue('timezone', event.target.value)}
            >
              {timezoneOptions.map((timezone) => (
                <option key={timezone.value} value={timezone.value}>
                  {timezone.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Platform</span>
            <select
              className="frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30"
              value={platform}
              onChange={(event) => updateBuildroot('platform', event.target.value)}
            >
              {buildrootPlatforms.map((platform) => (
                <option key={platform.value} value={platform.value}>
                  {platform.label}
                </option>
              ))}
            </select>
          </label>
          <AdvancedSection label="advanced: installation mode" open={compilationMode === 'static'}>
            <label className="block space-y-1">
              <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Installation mode</span>
              <select
                className="frameos-form-control h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30"
                value={compilationMode}
                onChange={(event) => updateBuildroot('compilationMode', event.target.value)}
              >
                {frameCompilationModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </AdvancedSection>
          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide">
              Root password
              {!rootPassword ? <span className="ml-1 text-red-500">Empty password is unsafe</span> : null}
            </span>
            <TextInput
              value={rootPassword}
              onChange={(value) => updateFrameValue('ssh_pass', value)}
              type="password"
              placeholder="Root password"
              autoComplete="new-password"
            />
          </label>
          <div className="space-y-2">
            <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">SSH keys</div>
            <SshKeysSection
              compact
              hideRemove
              selectedIds={Array.from(selectedSshKeys)}
              onSelectionChange={(ids) => updateFrameValue('ssh_keys', ids)}
              description="Installed on the card as root's authorized keys."
            />
          </div>

          <label className="block space-y-1">
            <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">WiFi network</span>
            <TextInput
              value={network.wifiSSID ?? ''}
              onChange={(value) => updateNetwork('wifiSSID', value)}
              placeholder="Home WiFi"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1">
            <span className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">WiFi password</span>
            <TextInput
              value={network.wifiPassword ?? ''}
              onChange={(value) => updateNetwork('wifiPassword', value)}
              type="password"
              placeholder="Network password"
              autoComplete="new-password"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={onDownload}
          className="frameos-primary-action inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <ArrowDownTrayIcon className="h-4 w-4" />
          Build / download SD card
        </button>
      </div>
    </section>
  )
}

function formatSyncTimestamp(timestamp?: string | null): string {
  if (!timestamp) {
    return 'Unknown'
  }
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return timestamp
  }
  return date.toLocaleString()
}

function syncDownloadFilename(change: FrameSyncChange, side: 'backend' | 'frame'): string {
  const name =
    change.label.replace(/^Scene (changed|added on frame|only in backend):\s*/i, '') || change.choice_key || 'scene'
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${safeName || 'scene'}-${side}.json`
}

function downloadSyncJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function FrameSyncSideLabel({
  change,
  side,
  label,
}: {
  change: FrameSyncChange
  side: 'backend' | 'frame'
  label: string
}): JSX.Element {
  const payload = side === 'backend' ? change.backend_json : change.frame_json
  return (
    <div className="frame-tool-muted flex items-center gap-1 font-semibold uppercase tracking-wide">
      <span>{label}</span>
      {change.kind === 'changed' && payload ? (
        <button
          type="button"
          title={`Download ${label.toLowerCase()} scene JSON`}
          onClick={() => downloadSyncJson(syncDownloadFilename(change, side), payload)}
          className="rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <ArrowDownTrayIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}

type FrameSyncAnyChoice = FrameSyncChoice | FrameSyncSceneChoice
type FrameSyncResolutionChoice = Exclude<FrameSyncAnyChoice, 'ignore'>
interface FrameSyncResolutionOption {
  choice: FrameSyncResolutionChoice
  label: string
  description: string
}

function syncChoiceLabel(choice: FrameSyncResolutionChoice, sectionId: FrameSyncSection['id']): string {
  if (choice === 'backend') {
    return 'Use backend'
  }
  if (choice === 'frame') {
    return 'Use frame'
  }
  if (choice === 'both' && sectionId === 'scenes_json') {
    return 'Keep both'
  }
  return 'Use backend'
}

function syncChoiceDescription(choice: FrameSyncResolutionChoice, sectionId: FrameSyncSection['id']): string {
  if (choice === 'backend') {
    return 'Commit the backend version to both sides.'
  }
  if (choice === 'frame') {
    return 'Commit the frame version to both sides.'
  }
  if (choice === 'both' && sectionId === 'scenes_json') {
    return 'Keep the backend scene and add the frame version as a copy.'
  }
  return 'Commit the backend version to both sides.'
}

function syncResolutionOptions(section: FrameSyncSection, change: FrameSyncChange): FrameSyncResolutionOption[] {
  if (section.id === 'scenes_json' && change.kind === 'added') {
    return [
      {
        choice: 'frame',
        label: 'Keep',
        description: 'Add this frame scene to the backend.',
      },
      {
        choice: 'backend',
        label: 'Delete',
        description: 'Remove this scene from the frame.',
      },
    ]
  }
  if (section.id === 'scenes_json' && change.kind === 'removed') {
    return [
      {
        choice: 'backend',
        label: 'Keep',
        description: 'Restore this backend scene to the frame.',
      },
      {
        choice: 'frame',
        label: 'Delete',
        description: 'Delete this scene from the backend.',
      },
    ]
  }
  const choices: FrameSyncResolutionChoice[] =
    section.id === 'scenes_json' ? ['backend', 'frame', 'both'] : ['backend', 'frame']
  return choices.map((choice) => ({
    choice,
    label: syncChoiceLabel(choice, section.id),
    description: syncChoiceDescription(choice, section.id),
  }))
}

function FrameSyncResolutionButtons({
  section,
  change,
  choice,
  onChange,
}: {
  section: FrameSyncSection
  change: FrameSyncChange
  choice: FrameSyncAnyChoice
  onChange: (choice: FrameSyncAnyChoice) => void
}): JSX.Element {
  const options = syncResolutionOptions(section, change)
  const defaultChoice = options[0]?.choice ?? 'backend'
  const selectedChoice: FrameSyncResolutionChoice =
    choice !== 'ignore' && options.some((option) => option.choice === choice) ? choice : defaultChoice
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((option) => (
        <button
          key={`${section.id}-${change.path}-resolution-${option.choice}`}
          type="button"
          aria-pressed={selectedChoice === option.choice}
          onClick={() => onChange(option.choice)}
          className={clsx(
            'rounded-xl border px-3 py-2 text-left text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
            selectedChoice === option.choice
              ? 'border-blue-300 bg-blue-50 text-blue-950 shadow-sm'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
          )}
        >
          <span className="block font-semibold">{option.label}</span>
          <span className="mt-0.5 block leading-4 text-current opacity-75">{option.description}</span>
        </button>
      ))}
    </div>
  )
}

function FrameSyncReviewSection({
  sync,
  choices,
  onChoice,
  onRefresh,
  loading,
  applying,
  error,
}: {
  sync: FrameSyncStatus
  choices: FrameSyncChoices
  onChoice: (sectionId: FrameSyncSection['id'], choiceKey: string, choice: FrameSyncAnyChoice) => void
  onRefresh: () => void
  loading: boolean
  applying: boolean
  error: string | null
}): JSX.Element {
  const sections = sync.sections.filter((section) => section.has_changes)
  const applyingTitle = 'Committing sync changes'
  const applyingDescription =
    'Writing the selected choices to the backend and the frame. Large scene files can take a moment to save.'
  const refreshButtonBusy = loading || applying
  const refreshButtonLabel = applying ? 'Syncing' : loading ? 'Refreshing' : 'Refresh'

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <DrawerHeading
          action={
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshButtonBusy}
              className="frameos-secondary-button inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
            >
              {refreshButtonBusy ? <Spinner className="flex h-3.5 w-3.5 items-center justify-center" /> : null}
              {refreshButtonLabel}
            </button>
          }
        >
          Sync from frame
        </DrawerHeading>
        <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
          <div className="frame-tool-muted text-sm leading-5">The backend copy and the live frame copy differ.</div>
          <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
            <div className="frameos-inset rounded-xl border p-3">
              <div className="frame-tool-muted font-semibold uppercase tracking-wide">Last in sync</div>
              <div className="mt-1 font-semibold text-[color:var(--tool-strong)]">
                {formatSyncTimestamp(sync.last_in_sync_at)}
              </div>
            </div>
            <div className="frameos-inset rounded-xl border p-3">
              <div className="frame-tool-muted font-semibold uppercase tracking-wide">Checked</div>
              <div className="mt-1 font-semibold text-[color:var(--tool-strong)]">
                {formatSyncTimestamp(sync.checked_at)}
              </div>
            </div>
          </div>
          {error ? <div className="text-sm font-semibold text-red-500">{error}</div> : null}
          {applying ? (
            <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
              <Spinner />
              <div>
                <div className="font-semibold">{applyingTitle}</div>
                <div className="mt-0.5 leading-5 text-blue-900/75">{applyingDescription}</div>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {sections.map((section) => (
        <section key={section.id} className="space-y-2">
          <DrawerHeading>{section.label}</DrawerHeading>
          <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div>
                <div className="frame-tool-muted font-semibold uppercase tracking-wide">Backend</div>
                <div className="mt-1 font-semibold text-[color:var(--tool-strong)]">
                  {section.backend_updated_at || sync.backend?.updated_at
                    ? formatSyncTimestamp(section.backend_updated_at ?? sync.backend?.updated_at)
                    : 'Current backend copy'}
                </div>
              </div>
              <div>
                <div className="frame-tool-muted font-semibold uppercase tracking-wide">Frame file</div>
                <div className="mt-1 font-semibold text-[color:var(--tool-strong)]">
                  {formatSyncTimestamp(section.frame_updated_at)}
                </div>
              </div>
            </div>
            <div className="space-y-3">
              {section.changes.map((change) => {
                const choiceKey = frameSyncChangeKey(change)
                const choice = choices[section.id]?.[choiceKey] ?? 'ignore'
                return (
                  <div key={`${section.id}-${change.path}`} className="frameos-inset rounded-xl border p-3">
                    <div className="flex items-start gap-2">
                      <ArrowsRightLeftIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-[color:var(--tool-strong)]">{change.label}</div>
                        <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                          <div>
                            <FrameSyncSideLabel change={change} side="backend" label="Backend" />
                            <div className="mt-0.5 break-words text-[color:var(--tool-strong)]">{change.backend}</div>
                          </div>
                          <div>
                            <FrameSyncSideLabel change={change} side="frame" label="Frame" />
                            <div className="mt-0.5 break-words text-[color:var(--tool-strong)]">{change.frame}</div>
                          </div>
                        </div>
                        {change.details?.length ? (
                          <div className="mt-3 space-y-1 border-t border-slate-200/70 pt-2">
                            {change.details.slice(0, 8).map((detail) => (
                              <div
                                key={`${change.path}-${detail.path}`}
                                className="grid grid-cols-[minmax(0,1fr)] gap-1 text-xs"
                              >
                                <div className="frame-tool-muted truncate font-mono">{detail.path}</div>
                                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                                  <div className="break-words text-slate-500">Backend: {detail.backend}</div>
                                  <div className="break-words text-slate-700">Frame: {detail.frame}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-3 border-t border-slate-200/70 pt-3">
                          <div className="frame-tool-muted mb-2 text-xs font-semibold uppercase tracking-wide">
                            Resolution
                          </div>
                          <FrameSyncResolutionButtons
                            section={section}
                            change={change}
                            choice={choice}
                            onChange={(next) => onChoice(section.id, choiceKey, next)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}

interface FrameBootstrapApiResponse {
  command: string
  // Set when the backend URL the script embeds is plain http: the script
  // carries the frame's API key and Remote secret, so the drawer says so.
  warning?: string | null
}

function ScriptInstallSection({ frame, onBack }: { frame: FrameType; onBack: () => void }): JSX.Element {
  const { loadFrame } = useActions(framesModel)
  const [command, setCommand] = useState('')
  const [transportWarning, setTransportWarning] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadCommand = async (regenerate = false): Promise<void> => {
    setLoading(true)
    setCopied(false)
    setError(null)
    setTransportWarning(null)
    try {
      const response = await apiFetch(
        `/api/frames/${frame.id}/frame_bootstrap?select_remote=1&regenerate=${regenerate ? 1 : 0}`,
        {
          method: 'POST',
        }
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(typeof payload?.detail === 'string' ? payload.detail : 'Failed to create install command')
      }
      const payload = (await response.json()) as FrameBootstrapApiResponse
      setCommand(payload.command)
      setTransportWarning(payload.warning ?? null)
      loadFrame(frame.id)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to create install command')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCommand()
  }, [frame.id])

  const copyCommand = (): void => {
    if (!command) {
      return
    }
    copy(command)
    setCopied(true)
  }

  return (
    <section className="mb-5 space-y-2">
      <DrawerHeading>
        <span className="inline-flex items-center gap-2">
          <BackToDeployButton onClick={onBack} />
          <span>Install with a script</span>
        </span>
      </DrawerHeading>
      <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
        <div className="frame-tool-muted text-sm leading-5">
          Run this command on the device as a user with sudo access. It installs FrameOS, starts FrameOS Remote, and
          connects back to this backend. The installer supports most major Debian and Ubuntu releases, including
          Raspberry Pi OS releases based on Debian.
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--tool-strong)]">
            <Spinner />
            Preparing command
          </div>
        ) : error ? (
          <div className="text-sm font-semibold text-red-500">{error}</div>
        ) : (
          <pre className="frameos-inset max-h-44 whitespace-pre-wrap break-all rounded-xl border p-3 text-xs leading-5 text-[color:var(--tool-strong)]">
            <code>{command}</code>
          </pre>
        )}
        {transportWarning ? (
          <div className="frameos-warning-button rounded-xl border px-3 py-2 text-xs leading-5">{transportWarning}</div>
        ) : null}
        <div className="frame-tool-muted text-xs leading-4">
          The installer downloads the signed FrameOS release and verifies its signature against the FrameOS release key
          on the device before anything from it runs.
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={copyCommand}
            disabled={!command}
            className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
          >
            <ClipboardDocumentIcon className="h-4 w-4" />
            {copied ? 'Copied' : 'Copy command'}
          </button>
          <button
            type="button"
            onClick={() => loadCommand(true)}
            disabled={loading}
            className="frameos-secondary-button rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
          >
            Regenerate
          </button>
        </div>
      </div>
    </section>
  )
}

function VirtualFrameUrlRow({ label, url }: { label: string; url: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-[color:var(--tool-strong)]">{label}</div>
      <pre className="frameos-inset whitespace-pre-wrap break-all rounded-xl border p-3 text-xs leading-5 text-[color:var(--tool-strong)]">
        <code>{url}</code>
      </pre>
      <button
        type="button"
        onClick={() => {
          copy(url)
          setCopied(true)
        }}
        className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <ClipboardDocumentIcon className="h-4 w-4" />
        {copied ? 'Copied' : 'Copy URL'}
      </button>
    </div>
  )
}

function OtaUpdateCard({
  onOtaUpdate,
  otaSupported,
  disabled,
  online = false,
}: {
  onOtaUpdate: () => void
  otaSupported: boolean
  disabled: boolean
  online?: boolean
}): JSX.Element {
  return (
    <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[color:var(--tool-strong)]">Over-the-air update</div>
          <div className="frame-tool-muted mt-1 text-sm leading-5">
            {otaSupported ? (
              <>
                Ask the frame to install the latest published FrameOS release. It downloads the signed image for its
                flash layout through this backend, verifies the release signature, and reboots into it; progress shows
                up in Logs as <code>ota:backend</code> lines.
                {online ? '' : ' Needs the frame on the network.'}
              </>
            ) : (
              'The 4MB flash profile uses a single app slot, so firmware updates must be flashed over USB.'
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onOtaUpdate}
          disabled={disabled || !otaSupported}
          className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
        >
          <CloudArrowUpIcon className="h-4 w-4" />
          Update over the air
        </button>
      </div>
    </div>
  )
}

function EmbeddedFirmwareSection({
  frame,
  onBack,
  onOtaUpdate,
}: {
  frame: FrameType
  onBack?: () => void
  onOtaUpdate: () => void
}): JSX.Element {
  const platformLabel = frame.embedded?.platform || 'esp32-s3'
  // The USB card owns its own busy state now; the OTA button only needs to
  // stay clickable.
  const releaseFlashBusy = false
  // Pico-family boards flash a generic UF2 release asset over BOOTSEL and are
  // provisioned over the USB serial console: no esptool, no browser flashing,
  // no OTA. Hide all of those controls.
  const isPicoPlatform = platformLabel.startsWith('pico')
  // Virtual frames have no hardware at all: the backend renders them, so
  // instead of firmware the section shows the image and kiosk page URLs.
  const isVirtualPlatform = platformLabel === EMBEDDED_VIRTUAL
  const virtualUrlOrigin = typeof window !== 'undefined' ? window.location.origin : ''
  // View-only credential, never the device API key: leaking a kiosk URL
  // grants nothing but the picture.
  const virtualUrlToken = frame.device_config?.viewToken || '<view-token>'
  const { loadFrame } = useActions(framesModel)
  const rotateVirtualViewToken = async (): Promise<void> => {
    const response = await apiFetch(`/api/frames/${frame.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_config: { ...(frame.device_config ?? {}), viewToken: secureToken(32) },
      }),
    })
    if (response.ok) {
      loadFrame(frame.id)
    }
  }
  const virtualImageUrl = `${virtualUrlOrigin}/api/frames/${frame.id}/virtual/image?k=${virtualUrlToken}`
  const virtualPageUrl = `${virtualUrlOrigin}/api/frames/${frame.id}/virtual/page?k=${virtualUrlToken}`
  const flashSize = embeddedFlashSize(frame)
  const otaSupported = embeddedOtaSupported(frame)
  const showUsbJtagPortGuidance = needsEsp32UsbJtagPortGuidance(frame)
  // The self-hosted backend serves the same release listing the cloud does;
  // a device's own frame-admin bundle serves neither that nor the
  // provisioning plan, so the release cards are backend-mode only.
  const releaseAvailable = workspaceMode() === 'backend' && hasReleaseFirmwarePlatform(frame)
  const releasePlatform = releaseAvailable ? releaseFirmwarePlatform(frame) : platformLabel
  // The manual recipe: the published merged image for this chip and flash
  // layout, written at 0x0 — the same bytes the browser flasher writes.
  const flashCommand = `esptool.py --chip ${platformLabel.replace(
    /-/g,
    ''
  )} --port /dev/tty.usbmodem* --baud 460800 --flash_size ${flashSize} write_flash 0x0 frameos-<version>-${releasePlatform}.bin`

  return (
    <section className="mb-5 space-y-2">
      <DrawerHeading action={<FrameSettingsLink frameId={frame.id} />}>
        <span className="inline-flex items-center gap-2">
          {onBack ? <BackToDeployButton onClick={onBack} /> : null}
          <span>{isVirtualPlatform ? 'Virtual frame' : 'Firmware'}</span>
        </span>
      </DrawerHeading>
      <div className="mb-3">
        <div className="frame-tool-muted mt-1 text-sm leading-5">
          {isVirtualPlatform ? (
            <>
              Nothing to flash: the backend renders this frame. Point any browser, tablet, or signage player at the
              kiosk page URL, or fetch the image URL for a PNG.
            </>
          ) : isPicoPlatform ? (
            <>
              This {platformLabel} board runs the generic FrameOS UF2 firmware: copy the release asset onto the board
              over BOOTSEL drag-and-drop and provision it over the USB serial console.{' '}
              <a
                href="https://github.com/FrameOS/frameos/releases/latest"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Download frameos-&lt;version&gt;-{platformLabel}.uf2 from the latest release
              </a>
              .
            </>
          ) : null}
        </div>
      </div>
      {isVirtualPlatform ? (
        <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
          <VirtualFrameUrlRow label="Image URL (PNG)" url={virtualImageUrl} />
          <VirtualFrameUrlRow label="Kiosk page URL (self-refreshing)" url={virtualPageUrl} />
          <div className="flex items-center gap-3">
            <Button size="small" color="secondary" onClick={rotateVirtualViewToken}>
              Rotate view token
            </Button>
            <span className="frame-tool-muted text-xs leading-4">
              Mints a new token and invalidates every shared URL immediately.
            </span>
          </div>
        </div>
      ) : isPicoPlatform ? null : (
        <>
          <div className="frame-tool-muted text-sm leading-5">
            Every ESP32 board runs the same signed FrameOS release image. Over USB the browser flashes it and tells the
            board which frame it is; the rest — scenes, service keys, the HTTPS certificate — arrives from this backend
            once the board is on Wi-Fi.
            {showUsbJtagPortGuidance ? (
              <span className="mt-2 block">
                The 13.3&quot; ESP32 board can appear as two serial ports and either works.
                <span className="font-semibold text-[color:var(--tool-strong)]"> USB JTAG/serial debug unit</span> is
                the fast one (logs, previews and scene uploads at USB speed);
                <span className="font-semibold text-[color:var(--tool-strong)]"> USB Single Serial</span> is the
                board&apos;s USB-UART bridge at 115200 baud, so uploads take longer there.
              </span>
            ) : null}
          </div>
          {/* Over the air first when the frame is online — it is the button that
              needs no cable — then the one USB action. */}
          {frame.status === 'ready' || frame.status === 'deploying' ? (
            <OtaUpdateCard onOtaUpdate={onOtaUpdate} otaSupported={otaSupported} disabled={releaseFlashBusy} online />
          ) : null}
          <EmbeddedUsbConnect frame={frame} manualFlashCommand={releaseAvailable ? flashCommand : undefined} />
          {frame.status === 'ready' || frame.status === 'deploying' ? null : (
            <OtaUpdateCard onOtaUpdate={onOtaUpdate} otaSupported={otaSupported} disabled={releaseFlashBusy} />
          )}
          <FirmwareFootprintVisualization frame={frame} />
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ cloud */

function normalizedFirmwareVersion(value?: string | null): string | null {
  const trimmed = (value ?? '').trim().replace(/^v/i, '')
  return trimmed || null
}

interface CloudFirmwareReleaseInfo {
  loading: boolean
  error: string | null
  /** Latest published release, normalized without the "v" prefix so it
   * compares against the device-reported frameos_version. */
  release: string | null
  /** Byte size of this frame's published firmware asset. */
  assetSize: number | null
}

function useCloudFirmwareRelease(frame: FrameType, enabled: boolean): CloudFirmwareReleaseInfo {
  const [info, setInfo] = useState<CloudFirmwareReleaseInfo>({
    loading: enabled,
    error: null,
    release: null,
    assetSize: null,
  })
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    setInfo({ loading: true, error: null, release: null, assetSize: null })
    Promise.all([fetchReleaseFirmwareListing(), releaseFirmwarePlatformForFrame(frame)])
      .then(([listing, platform]) => {
        if (cancelled) {
          return
        }
        const asset = listing.assets?.find((entry) => entry.platform === platform)
        setInfo({
          loading: false,
          error: null,
          release: normalizedFirmwareVersion(listing.release),
          assetSize: asset?.size ?? null,
        })
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setInfo({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          release: null,
          assetSize: null,
        })
      })
    return () => {
      cancelled = true
    }
  }, [frame.id, enabled])
  return info
}

function formatUptime(seconds?: number | null): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null
  }
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) {
    return `${days}d ${hours}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

type CloudStatusTone = 'ok' | 'warn' | 'muted'

function CloudStatusRow({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone: CloudStatusTone
}): JSX.Element {
  return (
    <div className="flex gap-2.5 text-sm">
      <span
        className={clsx(
          'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full',
          tone === 'ok' ? 'bg-emerald-400' : tone === 'warn' ? 'bg-amber-400' : 'bg-slate-300/80'
        )}
      />
      <div className="min-w-0 flex-1">
        <span className="frame-tool-muted mr-2 text-xs font-semibold uppercase tracking-wide">{label}</span>
        <span className="font-semibold text-[color:var(--tool-strong)]">{value}</span>
        {detail ? <div className="frame-tool-muted mt-0.5 text-xs leading-4">{detail}</div> : null}
      </div>
    </div>
  )
}

/**
 * The "what is there to update" summary every cloud deploy view opens with:
 * connection, firmware version vs. the published release, and whether the
 * scenes/settings on the device match what this account has assigned.
 */
function CloudDeployStatus({
  frame,
  isEsp32,
  releaseInfo,
}: {
  frame: FrameType
  isEsp32: boolean
  releaseInfo: CloudFirmwareReleaseInfo
}): JSX.Element {
  const { frameForm, unsavedChangeDetails } = useValues(frameLogic({ frameId: frame.id }))
  const scenes = frameForm?.scenes ?? frame.scenes ?? []
  const offline = frame.connected === false
  const neverEnrolled = frame.status === 'pending'
  const deviceVersion = normalizedFirmwareVersion(frame.frameos_version)
  const checkin = frameCheckin(frame)

  let connection: JSX.Element
  if (neverEnrolled) {
    connection = (
      <CloudStatusRow
        label="Connection"
        value="No board enrolled"
        detail="No device has claimed this frame yet — only the USB path below can reach it."
        tone="warn"
      />
    )
  } else if (offline && checkin?.kind === 'sleeping') {
    // A battery frame between wakes: not a problem, just a schedule. Say
    // when the push lands rather than "offline".
    const wakeClock = new Date(checkin.wakeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    connection = (
      <CloudStatusRow
        label="Connection"
        value="Asleep"
        detail={
          (checkin.announced
            ? `Deep sleeping between renders${
                checkin.reason === 'battery_critical' ? ' (battery critical — sleeping long to protect the cell)' : ''
              }. `
            : 'Deep sleep between renders is on; this firmware does not announce its sleeps, so the wake is estimated. ') +
          `Wakes ${formatFrameRelativeFuture(
            checkin.wakeAt,
            Date.now(),
            checkin.announced ? '' : '~'
          )} (${wakeClock})` +
          (checkin.renderAt
            ? ` to check for commands; the next panel refresh is ${formatFrameRelativeFuture(checkin.renderAt)}.`
            : '.') +
          ' Pushes queue on the account and apply on that wake.'
        }
        tone="muted"
      />
    )
  } else if (offline && checkin?.kind === 'overdue') {
    connection = (
      <CloudStatusRow
        label="Connection"
        value="Overdue"
        detail={`Expected back ${formatFrameRelativeTime(checkin.wakeAt)}${
          checkin.announced ? '' : ' (estimated)'
        } but has not reconnected — last seen ${
          formatFrameRelativeTime(frame.last_seen_at) ?? 'never'
        }. Check its battery and Wi-Fi. Pushes stay queued until it reconnects.`}
        tone="warn"
      />
    )
  } else if (offline) {
    connection = (
      <CloudStatusRow
        label="Connection"
        value="Offline"
        detail={
          frame.last_seen_at
            ? `Last seen ${formatSyncTimestamp(
                frame.last_seen_at
              )}. Pushes queue on the account and apply when it reconnects.`
            : 'Pushes queue on the account and apply when it reconnects.'
        }
        tone="warn"
      />
    )
  } else {
    connection = (
      <CloudStatusRow
        label="Connection"
        value="Online"
        detail="Connected to the cloud right now — pushes apply immediately."
        tone="ok"
      />
    )
  }

  // Version row for every cloud frame: the esp32 swaps firmware images, the
  // Pi upgrades its FrameOS release, but "device version vs latest published
  // release" reads the same either way.
  const versionLabel = isEsp32 ? 'Firmware' : 'FrameOS'
  let firmware: JSX.Element | null = null
  if (deviceVersion && releaseInfo.release) {
    firmware =
      deviceVersion === releaseInfo.release ? (
        <CloudStatusRow
          label={versionLabel}
          value={deviceVersion}
          detail="Up to date with the latest release."
          tone="ok"
        />
      ) : (
        <CloudStatusRow
          label={versionLabel}
          value={`${deviceVersion} → ${releaseInfo.release}`}
          detail="A newer release is published."
          tone="warn"
        />
      )
  } else if (deviceVersion) {
    firmware = (
      <CloudStatusRow
        label={versionLabel}
        value={deviceVersion}
        detail={
          releaseInfo.loading
            ? 'Checking the latest published release…'
            : releaseInfo.error ?? 'Could not determine the latest published release.'
        }
        tone="muted"
      />
    )
  } else {
    firmware = (
      <CloudStatusRow
        label={versionLabel}
        value="Not reported yet"
        detail="The device reports its version when it connects."
        tone="muted"
      />
    )
  }

  const scenesValue = `${scenes.length} scene${scenes.length === 1 ? '' : 's'}`
  let scenesRow: JSX.Element
  if (unsavedChangeDetails.length > 0) {
    scenesRow = (
      <CloudStatusRow
        label="Scenes & settings"
        value={`${scenesValue} · ${unsavedChangeDetails.length} unsaved change${
          unsavedChangeDetails.length === 1 ? '' : 's'
        }`}
        detail={unsavedChangeDetails.map((change) => change.label).join(', ')}
        tone="warn"
      />
    )
  } else if (!frame.scenes_checksum) {
    scenesRow = (
      <CloudStatusRow
        label="Scenes & settings"
        value={scenesValue}
        detail="The device has not confirmed receiving any scenes yet."
        tone="muted"
      />
    )
  } else if (frame.assigned_checksum && frame.assigned_checksum === frame.scenes_checksum) {
    scenesRow = (
      <CloudStatusRow
        label="Scenes & settings"
        value={scenesValue}
        detail="No unsaved changes; the device has applied the last push."
        tone="ok"
      />
    )
  } else {
    scenesRow = (
      <CloudStatusRow
        label="Scenes & settings"
        value={scenesValue}
        detail="The device has not confirmed the last push yet."
        tone="warn"
      />
    )
  }

  return (
    <section className="space-y-2">
      <DrawerHeading action={<FrameSettingsLink frameId={frame.id} />}>What's on the frame</DrawerHeading>
      <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
        {connection}
        {firmware}
        {scenesRow}
      </div>
    </section>
  )
}

function CloudDeployChoiceButton({
  icon,
  title,
  description,
  onClick,
}: {
  icon: JSX.Element
  title: string
  description: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="frame-tool-card w-full rounded-[22px] p-4 text-left transition hover:border-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <div className="flex items-start gap-3">
        <span className="frameos-primary-text mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-sm font-semibold text-[color:var(--tool-strong)]">
            {title}
            <ChevronRightIcon className="h-4 w-4 shrink-0" />
          </span>
          <span className="frame-tool-muted mt-1 block text-sm leading-5">{description}</span>
        </span>
      </div>
    </button>
  )
}

/**
 * The push half of a cloud deploy: settings save + one checksummed
 * set_scenes (frameLogic's cloudSaveAndDeploy). Shared between the esp32
 * over-the-air view and the plain view non-esp32 cloud frames get.
 */
function CloudScenesPushCard({ frame, onPushed }: { frame: FrameType; onPushed: () => void }): JSX.Element {
  const { unsavedChangeDetails } = useValues(frameLogic({ frameId: frame.id }))
  const { saveAndDeployFrame } = useActions(frameLogic({ frameId: frame.id }))
  const offline = frame.connected === false
  const checkin = frameCheckin(frame)
  // Nothing to send and the device already acked the last push: the button
  // still works (a re-send is idempotent) but it is not what this screen is
  // asking you to do, so it stops competing with the firmware upgrade next
  // to it for the one primary-coloured slot.
  const inSync =
    unsavedChangeDetails.length === 0 &&
    Boolean(frame.assigned_checksum) &&
    frame.assigned_checksum === frame.scenes_checksum

  return (
    <section className="space-y-2">
      <DrawerHeading>Scenes &amp; settings</DrawerHeading>
      <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
        <div className="frame-tool-muted text-sm leading-5">
          Saves this frame's settings and scenes to your cloud account, then pushes the scene list to the device.{' '}
          {offline
            ? checkin?.kind === 'sleeping'
              ? `The frame is asleep — the push is queued and applied when it wakes ${formatFrameRelativeFuture(
                  checkin.wakeAt,
                  Date.now(),
                  checkin.announced ? '' : '~'
                )}.`
              : checkin?.kind === 'overdue'
              ? `The frame is overdue (expected back ${formatFrameRelativeTime(
                  checkin.wakeAt
                )}) — the push is queued until it reconnects.`
              : 'The frame is offline right now — the push is queued and applied when it reconnects.'
            : 'The frame applies them as soon as it syncs.'}
        </div>
        <SummaryRows
          items={[
            {
              label: 'This push sends',
              value:
                unsavedChangeDetails.length === 0
                  ? 'No unsaved changes — this re-sends the current scenes'
                  : unsavedChangeDetails.map((change) => change.label).join(', '),
            },
          ]}
        />
        <button
          type="button"
          title="Save this frame's settings and push its scenes to the device"
          onClick={() => {
            saveAndDeployFrame()
            onPushed()
          }}
          className={clsx(
            inSync ? 'frameos-secondary-button' : 'frameos-primary-action',
            'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
          )}
        >
          <CloudArrowUpIcon className="h-4 w-4" />
          Push scenes &amp; settings
        </button>
      </div>
    </section>
  )
}

function CloudOtaDeployView({
  frame,
  releaseInfo,
  onBack,
  onPushed,
}: {
  frame: FrameType
  releaseInfo: CloudFirmwareReleaseInfo
  onBack: () => void
  onPushed: () => void
}): JSX.Element {
  const { updateFrameFirmware } = useActions(framesModel)
  const { saveAndDeployFrame } = useActions(frameLogic({ frameId: frame.id }))
  const { frameForm, unsavedChangeDetails } = useValues(frameLogic({ frameId: frame.id }))
  // Mirrors CloudPiUpdateCard: one press converges firmware + scenes +
  // settings — but "converge" means "make equal", so when there is nothing
  // unsaved and the device acked the last push, the tick sends nothing. The
  // redelivery was technically idempotent server-side, yet the device still
  // reloaded and re-rendered for it: an e-ink flash and a page of log lines
  // per upgrade click.
  const [alsoPushScenes, setAlsoPushScenes] = useState(true)
  const scenesInSync =
    unsavedChangeDetails.length === 0 &&
    Boolean(frame.assigned_checksum) &&
    frame.assigned_checksum === frame.scenes_checksum
  // Nothing assigned → nothing to resend; the tick is not offered.
  const hasScenes = (frameForm?.scenes ?? frame.scenes ?? []).length > 0
  const offerResend = hasScenes && !scenesInSync
  const { openFrameToolBehindDrawer } = useActions(workspaceLogic)
  const mode = workspaceMode()
  const canUpdateFirmware = frameMenuActionIsAllowed(mode, 'updateFirmware', frame)
  const firmwareDisabledReason = frameMenuActionDisabledReason(mode, 'updateFirmware', frame)
  const deviceVersion = normalizedFirmwareVersion(frame.frameos_version)
  const upToDate = Boolean(deviceVersion && releaseInfo.release && deviceVersion === releaseInfo.release)

  return (
    <>
      {/* Order: the action the user came for (firmware) sits where the
          "Over the air" button was, then scenes & settings, then logs. */}
      <section className="space-y-2">
        <DrawerHeading>
          <span className="inline-flex items-center gap-2">
            <BackToDeployButton onClick={onBack} />
            <span>Firmware</span>
          </span>
        </DrawerHeading>
        <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
          {canUpdateFirmware ? (
            <>
              <div className="frame-tool-muted text-sm leading-5">
                Queues an update notification for the frame (valid for 24 hours). When the frame picks it up, it
                downloads the latest released image from the cloud, verifies the signature on the device itself,
                installs it into the spare OTA slot and reboots. Progress shows up in Logs as <code>ota:cloud</code>{' '}
                lines.
              </div>
              {upToDate ? (
                <div className="frame-tool-muted text-xs leading-4">
                  The device already runs the latest release ({releaseInfo.release}); asking it to update is a no-op.
                </div>
              ) : null}
              <button
                type="button"
                title={
                  firmwareDisabledReason ??
                  (alsoPushScenes && offerResend
                    ? 'Queue a firmware update and resend this frame’s scenes & settings'
                    : 'Queue a firmware update notification')
                }
                disabled={Boolean(firmwareDisabledReason)}
                onClick={() => {
                  if (alsoPushScenes && offerResend) {
                    // Scenes first: the OTA reboot redelivers a queued push
                    // when the frame reconnects.
                    saveAndDeployFrame()
                  }
                  updateFrameFirmware(frame.id)
                }}
                // Primary while the device is behind the published release —
                // an available upgrade is the thing to do on this screen.
                className={clsx(
                  upToDate ? 'frameos-secondary-button' : 'frameos-primary-action',
                  'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'
                )}
              >
                <CloudArrowDownIcon className="h-4 w-4" />
                {/* Constant label: the checkbox below says whether scenes ride
                    along, so a button that renamed itself to "Update
                    everything" only made the two disagree about what it does. */}
                Upgrade firmware
              </button>
              {/* Nothing to resend when the device already acked everything:
                  a tick that sends nothing only invites the question of why
                  it is there, so the sentence stands alone. */}
              {offerResend ? (
                <Checkbox label="Resend scenes & settings" value={alsoPushScenes} onChange={setAlsoPushScenes} />
              ) : hasScenes ? (
                <div className="frame-tool-muted text-xs leading-4">
                  Scenes &amp; settings are already in sync — nothing extra is sent.
                </div>
              ) : null}
            </>
          ) : (
            <div className="frame-tool-muted text-sm leading-5">
              {firmwareDisabledReason ?? 'Firmware updates are not available for this frame.'}
            </div>
          )}
        </div>
      </section>

      <CloudScenesPushCard frame={frame} onPushed={onPushed} />

      <section className="space-y-2">
        <DrawerHeading>Logs</DrawerHeading>
        <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
          <div className="frame-tool-muted text-sm leading-5">
            Pushes are saved to your account first and delivered over the frame&apos;s own connection — at once while it
            is online, otherwise when it next reconnects. The frame confirms each one.
          </div>
          <button
            type="button"
            onClick={() => openFrameToolBehindDrawer(frame.id, 'logs')}
            className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <CommandLineIcon className="h-4 w-4" />
            Follow along in Logs
          </button>
        </div>
      </section>
    </>
  )
}

/**
 * The USB counterpart of CloudScenesPushCard: `usb_api upload-scenes` with
 * the same scene bodies the over-the-air push sends (the workspace hydrates
 * them into frameForm.scenes). For a board that cannot reach the cloud this
 * is the only way to get scenes onto it; the cloud remains the authority —
 * when the frame reconnects, its hello reports a different checksum and the
 * hub re-pushes the assigned set.
 */
function CloudUsbScenesPushCard({ frame }: { frame: FrameType }): JSX.Element {
  const { frameForm } = useValues(frameLogic({ frameId: frame.id }))
  const { usbLogStreamStatesByFrameId } = useValues(embeddedUsbLogsModel)
  const usbLogStreamOpen = isEmbeddedUsbLogStreamOpen(usbLogStreamStatesByFrameId[frame.id])
  const usbConnected = usbLogStreamOpen || embeddedUsbApiCanUse(frame.id)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scenes = frameForm?.scenes ?? frame.scenes ?? []

  const pushScenes = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      await pushScenesOverUsb(frame.id, scenes)
      setMessage(
        `${pushedScenesMessage(scenes.length)} The cloud reconciles the sync state when the frame next connects.`
      )
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : String(pushError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2">
      <DrawerHeading>Push scenes &amp; settings</DrawerHeading>
      <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
        <div className="frame-tool-muted text-sm leading-5">
          Copies the workspace's current scenes onto the board over the cable, so it can render them with no network at
          all. Settings stay cloud-delivered: the frame picks them up — and confirms the scene push — the next time it
          connects.
        </div>
        {!usbConnected ? (
          <div className="flex flex-wrap items-center gap-3">
            <EmbeddedUsbConnectionButton frame={frame} />
            <span className="frame-tool-muted text-xs leading-4">Connect the board over USB to push scenes.</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={pushScenes}
            disabled={busy || scenes.length === 0}
            title={scenes.length === 0 ? 'This frame has no scenes to push' : 'Send the current scenes over USB'}
            className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
          >
            {busy ? <Spinner color="white" /> : <CloudArrowUpIcon className="h-4 w-4" />}
            {busy ? 'Pushing scenes' : 'Push scenes over USB'}
          </button>
        )}
        {message ? <div className="text-xs font-semibold text-green-600">{message}</div> : null}
        {error ? <div className="text-xs font-semibold text-red-500">{error}</div> : null}
      </div>
    </section>
  )
}

function CloudUsbDeployView({ frame, onBack }: { frame: FrameType; onBack?: () => void }): JSX.Element {
  const showUsbJtagPortGuidance = needsEsp32UsbJtagPortGuidance(frame)
  // Cloud-only, handed down through the registry: minting a claim token bound
  // to an existing frame is a cloud operation the shared bundle cannot do.
  const UsbRelinkPanel = registeredFramePanel('usbRelink')

  return (
    <>
      <section className="space-y-2">
        <DrawerHeading>
          <span className="inline-flex items-center gap-2">
            {onBack ? <BackToDeployButton onClick={onBack} /> : null}
            <span>Over USB</span>
          </span>
        </DrawerHeading>
        <div className="frame-tool-card space-y-2 rounded-[22px] p-4">
          <div className="frame-tool-muted text-sm leading-5">
            Everything here talks to the board over its USB serial port, straight from this browser — it works with no
            network at all.
          </div>
          {showUsbJtagPortGuidance ? (
            <div className="frame-tool-muted text-xs leading-4">
              This board can appear as two serial ports and either works.{' '}
              <span className="font-semibold text-[color:var(--tool-strong)]">USB JTAG/serial debug unit</span> is the
              fast one; <span className="font-semibold text-[color:var(--tool-strong)]">USB Single Serial</span> is the
              board&apos;s USB-UART bridge at 115200 baud.
            </div>
          ) : null}
        </div>
      </section>

      {/* One USB action (EmbeddedUsbConnect): connect, read the board, and
          show the step that applies — firmware kept in step for this frame,
          Wi-Fi when it is off the network, and a pointer at the re-link panel
          below for a blank or foreign board. Scenes follow as their own card. */}
      <section className="space-y-2">
        <EmbeddedUsbConnect frame={frame} />
      </section>

      <CloudUsbScenesPushCard frame={frame} />

      {UsbRelinkPanel ? <UsbRelinkPanel frame={frame} /> : null}
    </>
  )
}

const cloudFlashSegmentColors: Record<string, string> = {
  nvs: '#0f766e',
  otadata: '#7c3aed',
  phy: '#0369a1',
  factory: '#64748b',
  ota_0: '#16a34a',
  ota_1: '#2563eb',
  state: '#b45309',
  free: '#e2e8f0',
}

interface CloudFlashSegment {
  label: string
  bytes: number
  color: string
}

function cloudFlashSegments(storage: NonNullable<NonNullable<FrameType['hardware']>['storage']>): CloudFlashSegment[] {
  const segments: CloudFlashSegment[] = []
  const push = (label: string, bytes?: number | null): void => {
    if (typeof bytes === 'number' && bytes > 0) {
      segments.push({ label, bytes, color: cloudFlashSegmentColors[label] ?? '#64748b' })
    }
  }
  push('nvs', storage.nvsBytes)
  push('otadata', storage.otadataBytes)
  push('phy', storage.phyBytes)
  push('factory', storage.factorySlotBytes)
  const otaSlots = storage.otaSlots ?? 0
  for (let slot = 0; slot < otaSlots; slot += 1) {
    push(`ota_${slot}`, storage.otaSlotBytes)
  }
  push('state', storage.stateBytes)
  const flashBytes = storage.flashBytes ?? 0
  const known = segments.reduce((total, segment) => total + segment.bytes, 0)
  // The remainder is the bootloader, the partition table and any unallocated
  // tail — the device reports partition sizes, not offsets.
  push('free', flashBytes - known)
  return flashBytes > 0 ? segments : []
}

/**
 * Everything the cloud knows about the physical board, in one place: the
 * hardware facts the device reports on every connect (fos_cloud.c
 * add_hardware_json — full detail needs 2026.8+ firmware) plus the live
 * numbers from its newest metrics sample.
 */
function CloudHardwareDetails({
  frame,
  releaseInfo,
}: {
  frame: FrameType
  releaseInfo: CloudFirmwareReleaseInfo
}): JSX.Element {
  const hardware = frame.hardware ?? {}
  const metrics = frame.last_metrics ?? {}
  const memory = hardware.memory
  const storage = hardware.storage
  const sd = hardware.sd
  const segments = storage ? cloudFlashSegments(storage) : []
  const flashBytes = storage?.flashBytes ?? 0
  const chipRevision =
    typeof hardware.chipRevision === 'number' && Number.isFinite(hardware.chipRevision)
      ? `rev ${Math.floor(hardware.chipRevision / 100)}.${hardware.chipRevision % 100}`
      : null
  const chipCores = typeof hardware.chipCores === 'number' && hardware.chipCores > 0 ? hardware.chipCores : null
  const boardDetail = [chipRevision, chipCores ? `${chipCores} core${chipCores === 1 ? '' : 's'}` : null]
    .filter(Boolean)
    .join(' · ')
  const uptime = formatUptime(typeof metrics.uptimeSeconds === 'number' ? metrics.uptimeSeconds : null)
  const wifiRssi = typeof metrics.wifiRssi === 'number' ? metrics.wifiRssi : null
  const freeHeapKB = typeof metrics.freeHeapKB === 'number' ? metrics.freeHeapKB : null
  const freePsramKB = typeof metrics.freePsramKB === 'number' ? metrics.freePsramKB : null
  const batteryPercent = typeof metrics.batteryPercent === 'number' ? metrics.batteryPercent : null
  const sdValue = !sd
    ? null
    : !sd.enabled
    ? 'not configured'
    : sd.mounted
    ? typeof sd.capacityBytes === 'number' && sd.capacityBytes > 0
      ? `${formatFirmwareBytes(sd.capacityBytes)} mounted`
      : 'mounted'
    : 'enabled, not mounted'
  const otaSlotBytes = storage?.otaSlotBytes ?? 0

  return (
    <section className="space-y-2">
      <DrawerHeading>Hardware</DrawerHeading>
      <div className="frame-tool-card space-y-5 rounded-[22px] p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <FirmwareStat
            label="Board"
            value={hardware.platform || 'esp32'}
            detail={boardDetail || (hardware.mac ? undefined : 'reported at enrollment')}
          />
          <FirmwareStat
            label="Panel"
            value={hardware.panel || hardware.device || 'none'}
            detail={hardware.width && hardware.height ? `${hardware.width}×${hardware.height}` : undefined}
          />
          {hardware.mac ? <FirmwareStat label="MAC" value={hardware.mac} /> : null}
          {memory?.psramBytes ? (
            <FirmwareStat
              label="PSRAM"
              value={formatFirmwareBytes(memory.psramBytes)}
              detail={freePsramKB !== null ? `${formatFirmwareBytes(freePsramKB * 1024)} free now` : undefined}
            />
          ) : null}
          {memory?.internalHeapBytes ? (
            <FirmwareStat
              label="Internal heap"
              value={formatFirmwareBytes(memory.internalHeapBytes)}
              detail={freeHeapKB !== null ? `${formatFirmwareBytes(freeHeapKB * 1024)} free now` : undefined}
            />
          ) : null}
          {flashBytes > 0 ? <FirmwareStat label="Flash" value={formatFirmwareBytes(flashBytes)} /> : null}
          {sdValue ? <FirmwareStat label="SD card" value={sdValue} /> : null}
          {uptime ? <FirmwareStat label="Uptime" value={uptime} detail="since last boot" /> : null}
          {wifiRssi !== null ? <FirmwareStat label="Wi-Fi signal" value={`${wifiRssi} dBm`} /> : null}
          {batteryPercent !== null ? <FirmwareStat label="Battery" value={`${batteryPercent}%`} /> : null}
        </div>

        {segments.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">
                Flash layout
              </div>
              <div className="frame-tool-muted truncate text-xs">{formatFirmwareBytes(flashBytes)}</div>
            </div>
            <div className="frameos-inset flex h-9 overflow-hidden rounded-lg border">
              {segments.map((segment) => {
                const width = percentOf(segment.bytes, flashBytes)
                return (
                  <div
                    key={segment.label}
                    title={`${segment.label}: ${formatFirmwareBytes(segment.bytes)}`}
                    className={clsx(
                      'relative min-w-[2px] border-r border-white/60 last:border-r-0',
                      segment.label === 'free' ? 'text-slate-700' : 'text-white'
                    )}
                    style={{ width: `${width}%`, backgroundColor: segment.color }}
                  >
                    {width >= 9 ? (
                      <span className="absolute inset-x-1 top-1/2 -translate-y-1/2 truncate text-center text-[10px] font-semibold">
                        {segment.label}
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
              {segments.map((segment) => (
                <div key={`${segment.label}-row`} className="contents">
                  <div className="min-w-0 truncate text-[color:var(--tool-strong)]">
                    <span
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: segment.color }}
                    />
                    {segment.label === 'free' ? 'bootloader + unallocated' : segment.label}
                  </div>
                  <div className="text-right text-[color:var(--tool-strong)]">{formatFirmwareBytes(segment.bytes)}</div>
                </div>
              ))}
            </div>
            {releaseInfo.assetSize && otaSlotBytes > 0 ? (
              <div className="frame-tool-muted text-xs leading-4">
                The latest published image is {formatFirmwareBytes(releaseInfo.assetSize)}
                {` — ${formatPercent(releaseInfo.assetSize, otaSlotBytes)} of an OTA slot.`}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="frame-tool-muted text-xs leading-4">
            Memory and flash-layout details are reported by 2026.8+ firmware; they fill in the next time the board
            connects after a firmware update.
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * The Pi/buildroot counterpart to the esp32 OTA view's firmware section:
 * queues the same notify_update_available nudge, but on this profile the
 * device answers by running its own signed release upgrade
 * (frameos/upgrade.nim) — it fetches the latest published FrameOS release
 * itself, verifies the minisign signature on the device, stages it next to
 * the current install and restarts into it. The cloud supplies no URLs and
 * no binaries either way.
 */
function CloudPiUpdateCard({
  frame,
  releaseInfo,
}: {
  frame: FrameType
  releaseInfo: CloudFirmwareReleaseInfo
}): JSX.Element | null {
  const { updateFrameFirmware } = useActions(framesModel)
  const { saveAndDeployFrame } = useActions(frameLogic({ frameId: frame.id }))
  const { frameForm, unsavedChangeDetails } = useValues(frameLogic({ frameId: frame.id }))
  // "One big button": converge the whole frame — firmware, scenes and
  // settings — in one press. Converge means "make equal": with nothing
  // unsaved and the last push acked, the tick sends nothing at all. The
  // redelivery it used to send was idempotent in effect but not in noise —
  // the device reloaded its config and re-rendered the panel twice per
  // upgrade click (once for set_settings, once for set_scenes).
  const [alsoPushScenes, setAlsoPushScenes] = useState(true)
  const scenesInSync =
    unsavedChangeDetails.length === 0 &&
    Boolean(frame.assigned_checksum) &&
    frame.assigned_checksum === frame.scenes_checksum
  // A frame with nothing assigned has nothing to resend either: the tick
  // would only send an empty scene list, so it is not offered.
  const hasScenes = (frameForm?.scenes ?? frame.scenes ?? []).length > 0
  const offerResend = hasScenes && !scenesInSync
  const mode = workspaceMode()
  if (!frameMenuActionIsAllowed(mode, 'updateFirmware', frame)) {
    return null
  }
  const disabledReason = frameMenuActionDisabledReason(mode, 'updateFirmware', frame)
  const deviceVersion = normalizedFirmwareVersion(frame.frameos_version)
  const upToDate = Boolean(deviceVersion && releaseInfo.release && deviceVersion === releaseInfo.release)

  return (
    <section className="space-y-2">
      <DrawerHeading>FrameOS update</DrawerHeading>
      <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
        <div className="frame-tool-muted text-sm leading-5">
          Queues an update notification for the frame (it stays valid for 24 hours). When the frame picks it up, it
          downloads the latest FrameOS release, verifies the signature on the device itself, installs it next to the
          current version and restarts into it. Progress shows up in Logs as <code>cloud:upgrade</code> lines.
        </div>
        {upToDate ? (
          <div className="frame-tool-muted text-xs leading-4">
            The device already runs the latest release ({releaseInfo.release}); asking it to update is a no-op.
          </div>
        ) : null}
        {offerResend ? (
          <Checkbox label="Resend scenes & settings" value={alsoPushScenes} onChange={setAlsoPushScenes} />
        ) : hasScenes ? (
          <div className="frame-tool-muted text-xs leading-4">
            Scenes &amp; settings are already in sync — nothing extra is sent.
          </div>
        ) : null}
        <button
          type="button"
          title={
            disabledReason ??
            (alsoPushScenes && offerResend
              ? 'Queue a FrameOS update and push this frame’s scenes & settings'
              : 'Queue a FrameOS update notification')
          }
          disabled={Boolean(disabledReason)}
          onClick={() => {
            if (alsoPushScenes && offerResend) {
              // Scenes first: the firmware update reboots the frame, and a
              // queued push simply redelivers after it reconnects.
              saveAndDeployFrame()
            }
            updateFrameFirmware(frame.id)
          }}
          // Primary while the device is behind the published release. The
          // status rows above already flag the version gap; a secondary
          // button next to the primary "Push scenes & settings" one made the
          // upgrade look like the optional half of this screen.
          className={clsx(
            upToDate ? 'frameos-secondary-button' : 'frameos-primary-action',
            'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'
          )}
        >
          <CloudArrowDownIcon className="h-4 w-4" />
          {/* Constant label — the checkbox above owns "and the scenes too". */}
          Upgrade FrameOS
        </button>
      </div>
    </section>
  )
}

/**
 * The deploy dialog for a cloud-managed frame.
 *
 * Nothing the backend drawer shows applies here: no build host, no SSH
 * transport, no fast/full distinction (cloud frames are interpreted-only),
 * no SD-card image and no deploy plan endpoint. The cloud has exactly two
 * transports to a frame, so that is the choice this drawer opens with:
 *
 *   Over the air   the frame's own outbound cloud connection — the scenes +
 *                  settings push (frameLogic's cloudSaveAndDeploy) and the
 *                  notify_update_available firmware nudge (the device
 *                  fetches and signature-verifies the image itself).
 *
 *   Over USB       WebSerial to a board plugged into this computer — the
 *                  NVS-sparing firmware update, the same scene bodies
 *                  pushed over the cable (usb_api upload-scenes), and
 *                  Wi-Fi/status repair (EmbeddedUsbConnect). The only path
 *                  that works when the board cannot reach the network,
 *                  which is why a frame no board has enrolled as yet skips
 *                  the choice and lands here directly. It is also how a
 *                  wiped board is put back on this frame: the firmware
 *                  update writes the identity along with the image, so
 *                  "Add frame" needs no separate reconnect path.
 *
 * Both views open with the same status summary (connection, firmware
 * version vs. the published release, scenes sync) and close with the
 * hardware panel built from what the device reports on every hello.
 *
 * Deliberately absent: the backend's release flasher, OTA-from-this-backend,
 * esptool command and footprint chart. The cloud has its own enrollment
 * flasher (Esp32CloudFlasher) and its own OTA nudge; both control planes
 * install the same published release binaries.
 */
function CloudDeploySection({
  frame,
  view,
  onSelectView,
  onClose,
}: {
  frame: FrameType
  view: DeployDrawerView
  onSelectView: (view: DeployDrawerView) => void
  onClose: () => void
}): JSX.Element {
  const mode = workspaceMode()
  const isEsp32 = isEsp32CloudFrame(frame, mode)
  const releaseInfo = useCloudFirmwareRelease(frame, true)
  const SdImagePanel = registeredFramePanel('sdImage')
  // A frame no board has enrolled as cannot be reached over the air at all
  // (its command queue 409s), so the OTA/USB choice would be a trick
  // question — land on USB directly.
  const usbOnly = isEsp32 && frame.status === 'pending'
  const activeView: 'main' | 'cloudOta' | 'cloudUsb' = !isEsp32
    ? 'main'
    : usbOnly
    ? 'cloudUsb'
    : view === 'cloudOta' || view === 'cloudUsb'
    ? view
    : 'main'

  return (
    <div className="space-y-5">
      <CloudDeployStatus frame={frame} isEsp32={isEsp32} releaseInfo={releaseInfo} />
      {/* Directly under the status rows: "Offline — pushes queue on the
          account" is the sentence this section answers. */}
      <PendingActionsSection frame={frame} />
      {!isEsp32 ? (
        <>
          {/* Same order as the esp32 views: the release upgrade first (the
              status rows above just said whether one is due), the scene push
              second. */}
          <CloudPiUpdateCard frame={frame} releaseInfo={releaseInfo} />
          <CloudScenesPushCard frame={frame} onPushed={onClose} />
          {/* Cloud-only, and last: writing a card is what you do when the
              hardware, not the deploy, is the problem. */}
          {SdImagePanel ? <SdImagePanel frame={frame} /> : null}
        </>
      ) : activeView === 'main' ? (
        <section className="space-y-2">
          <DrawerHeading>Deploy</DrawerHeading>
          <CloudDeployChoiceButton
            icon={<CloudArrowUpIcon className="h-6 w-6" />}
            title="Over the air"
            description="Use the frame's own cloud connection: push scenes and settings, or start a firmware update. Nothing to plug in."
            onClick={() => onSelectView('cloudOta')}
          />
          <CloudDeployChoiceButton
            icon={<CpuChipIcon className="h-6 w-6" />}
            title="Over USB"
            description="For a board plugged into this computer: update its firmware, push scenes over the cable, or fix Wi-Fi credentials. Works with no network."
            onClick={() => onSelectView('cloudUsb')}
          />
        </section>
      ) : activeView === 'cloudOta' ? (
        <CloudOtaDeployView
          frame={frame}
          releaseInfo={releaseInfo}
          onBack={() => onSelectView('main')}
          onPushed={onClose}
        />
      ) : (
        <CloudUsbDeployView frame={frame} onBack={usbOnly ? undefined : () => onSelectView('main')} />
      )}
      {isEsp32 ? <CloudHardwareDetails frame={frame} releaseInfo={releaseInfo} /> : null}
    </div>
  )
}

export function FrameDeployPlanDrawer({ frame }: { frame: FrameType }): JSX.Element | null {
  useMountedLogic(logsLogic({ frameId: frame.id }))
  const {
    remoteDeployConnected,
    deployChangeDetails,
    deployPlansError,
    deployPlansLoading,
    deployPlansLoadingStartedAt,
    deployRecommendation,
    deployDrawerView,
    deployTransportToggleVisible,
    deployWithAgent,
    frameForm,
    frameSyncApplyMode,
    frameSyncApplying,
    frameSyncChoices,
    frameSyncError,
    frameSyncStatus,
    frameSyncStatusLoading,
    fullDeployPlanSummary,
    hasFrameSyncChanges,
  } = useValues(frameLogic({ frameId: frame.id }))
  const {
    applyFrameSync,
    hideDeployPlanModal,
    deployRemote,
    ignoreFrameSyncChanges,
    loadDeployPlans,
    loadFrameSyncStatus,
    restartRemote,
    saveAndFastDeployFrame,
    saveAndFullDeployFrame,
    setFrameSyncItemChoice,
    setDeployWithAgent,
  } = useActions(frameLogic({ frameId: frame.id }))
  const { closeFrameChangeDrawer, openFrameChangeDrawer } = useActions(workspaceLogic)
  const { applyEmbeddedFirmwareOta, cancelDeploy, downloadSdCardImage, loadFrame } = useActions(framesModel)
  const { logs } = useValues(logsLogic({ frameId: frame.id }))
  const { savedSettings } = useValues(settingsLogic)
  const defaultTimezone = savedSettings.defaults?.timezone

  // Everything below this line is backend-shaped: frame.mode, deploy plans,
  // SSH transports, firmware the backend builds. A cloud frame has none of
  // those fields (its summary carries `hardware`, not `mode`), so the cloud
  // takes its own branch in both the body and the footer and reads none of
  // it. See CloudDeploySection.
  const isCloud = workspaceMode() === 'cloud'
  const deployPlanLogs = deployPlanLogsSince(logs, deployPlansLoadingStartedAt)
  const isBuildrootFrame = (frame.mode ?? 'rpios') === 'buildroot'
  const isEmbeddedFrame = (frame.mode ?? 'rpios') === 'embedded'
  const embeddedFastDeployReady = isEmbeddedFrame && frameHasActivityLog(frame)
  const embeddedPlatform = frameForm.embedded?.platform ?? frame.embedded?.platform ?? ''
  // ESP32 targets get a real full deploy: the latest release delivered over
  // the air. The Pico family runs a generic UF2 with no OTA, and 2/4MB flash
  // profiles have a single app slot (no OTA), so both keep fast deploy only.
  const embeddedFullDeploySupported =
    isEmbeddedFrame &&
    embeddedPlatform !== EMBEDDED_VIRTUAL &&
    !embeddedPlatform.startsWith('pico') &&
    embeddedOtaSupported(frame)
  const hasSuccessfulDeploy = Boolean(
    frame.last_successful_deploy_at || frame.last_successful_deploy || embeddedFastDeployReady
  )
  const firstInstall = !hasSuccessfulDeploy
  const directSdCardFirstInstall = firstInstall && isBuildrootFrame && deployDrawerView === 'main'
  const activeDeployDrawerView = directSdCardFirstInstall
    ? 'sdCard'
    : isEmbeddedFrame && !embeddedFastDeployReady
    ? 'embedded'
    : deployDrawerView
  const closeOnlyDrawerView = directSdCardFirstInstall || (isEmbeddedFrame && !embeddedFastDeployReady)
  const canDeployRemote = true
  const canCopyBootstrapScript = !isBuildrootFrame
  const canBootstrapFrameOS = !firstInstall && !frame.last_successful_deploy_at && !isBuildrootFrame
  const showRecompileRemote = import.meta.env?.DEV === true
  const remoteUpgradeNotice = buildRemoteUpgradeNotice(frame)
  const closeAndRun = (action: () => void): void => {
    action()
    hideDeployPlanModal()
    closeFrameChangeDrawer()
  }

  const closeDrawer = (): void => {
    hideDeployPlanModal()
    closeFrameChangeDrawer()
  }
  const showDeployDrawerView = (view: DeployDrawerView): void => {
    openFrameChangeDrawer(frame.id, 'deploy', view)
  }
  const showMainDeployView = (): void => showDeployDrawerView('main')
  const deploySummaryWithoutBuildOptions = fullDeployPlanSummary.filter(
    (item) => item.label !== 'Build strategy' && item.label !== 'Compilation'
  )
  const canApplyFrameSync =
    Object.values(frameSyncChoices.frame_json).some((choice) => choice !== 'ignore') ||
    Object.values(frameSyncChoices.scenes_json).some((choice) => choice !== 'ignore')
  const frameSyncStatusNeedsRefresh =
    hasFrameSyncChanges &&
    Boolean(frame.frame_sync_hint?.has_changes) &&
    (!frameSyncStatus || !frameSyncStatus.has_changes)
  const frameSyncStatusReady = Boolean(frameSyncStatus && !frameSyncStatusNeedsRefresh)
  const canIgnoreFrameSyncChanges = hasFrameSyncChanges && !frameSyncStatusLoading

  const saveSdCardSettingsAndDownload = async (): Promise<void> => {
    const response = await apiFetch(`/api/frames/${frame.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'buildroot',
        assets_path: '/srv/assets',
        device: frameForm.device ?? frame.device,
        device_config: frameForm.device_config ?? frame.device_config,
        ssh_pass: frameForm.ssh_pass ?? frame.ssh_pass ?? '',
        ssh_keys: effectiveSshKeyIds(frame, frameForm, savedSettings),
        server_host: frameForm.server_host ?? frame.server_host,
        server_port: frameForm.server_port ?? frame.server_port,
        timezone: normalizedTimezone(frameForm.timezone ?? frame.timezone, defaultTimezone),
        network: {
          ...(frame.network ?? {}),
          ...(frameForm.network ?? {}),
        },
        buildroot: {
          ...(frame.buildroot ?? {}),
          ...(frameForm.buildroot ?? {}),
        },
      }),
    })
    if (!response.ok) {
      throw new Error('Failed to save SD card settings')
    }
    loadFrame(frame.id)
    downloadSdCardImage(frame.id)
  }

  return (
    <div className="workspace-drawer frameos-drawer fixed bottom-5 right-5 top-5 z-40 flex w-[430px] overflow-hidden rounded-[24px] border border-white/80 bg-white/95 shadow-2xl shadow-slate-500/30 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="frameos-divider flex items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
          <div className="min-w-0">
            <div className="frameos-muted text-xs font-semibold uppercase tracking-wide text-slate-400">
              {frame.name || frameHost(frame)}
            </div>
            <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">
              {hasFrameSyncChanges ? 'Sync' : 'Deploy'}
            </h2>
          </div>
          <button
            type="button"
            onClick={closeDrawer}
            className="frameos-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {isCloud ? (
            <CloudDeploySection
              frame={frame}
              view={deployDrawerView}
              onSelectView={showDeployDrawerView}
              onClose={closeDrawer}
            />
          ) : activeDeployDrawerView === 'embedded' ? (
            <EmbeddedFirmwareSection
              frame={frame}
              onBack={embeddedFastDeployReady ? showMainDeployView : undefined}
              onOtaUpdate={() => applyEmbeddedFirmwareOta(frame.id)}
            />
          ) : activeDeployDrawerView === 'sdCard' ? (
            <BuildrootSdCardSection
              frame={frame}
              frameForm={frameForm}
              onBack={directSdCardFirstInstall ? undefined : showMainDeployView}
              onDownload={() => closeAndRun(saveSdCardSettingsAndDownload)}
              defaultTimezone={defaultTimezone}
            />
          ) : activeDeployDrawerView === 'script' ? (
            <ScriptInstallSection frame={frame} onBack={showMainDeployView} />
          ) : (
            <>
              {/* Backend frames push over SSH/HTTP the moment you click, so
                  this is normally empty. The exception is an ESP32 OTA
                  request recorded while its firmware is still building. */}
              <PendingActionsSection frame={frame} className="mb-4" />
              {!isEmbeddedFrame ? <AlternativesSection onSelect={showDeployDrawerView} /> : null}
              {canBootstrapFrameOS ? (
                <div className="mb-4">
                  <FrameBootstrapAction frame={frame} />
                </div>
              ) : null}
              {/* Shown from the first visit: choosing SSH is exactly what you
                  need before a frame has ever deployed, and gating it on a
                  past successful deploy left no way to pick a transport for a
                  frame whose remote never connects. */}
              {deployTransportToggleVisible ? (
                <DeployTransportToggle
                  frameId={frame.id}
                  remoteConnected={remoteDeployConnected}
                  remoteUpgradeNotice={remoteUpgradeNotice}
                  canDeployRemote={canDeployRemote}
                  canCopyBootstrapScript={canCopyBootstrapScript}
                  showRecompileRemote={showRecompileRemote}
                  onDeployRemote={deployRemote}
                  onRestartRemote={restartRemote}
                  deployWithAgent={deployWithAgent}
                  onChange={setDeployWithAgent}
                />
              ) : null}
              {hasFrameSyncChanges && frameSyncStatusReady && frameSyncStatus ? (
                <FrameSyncReviewSection
                  sync={frameSyncStatus}
                  choices={frameSyncChoices}
                  onChoice={setFrameSyncItemChoice}
                  onRefresh={loadFrameSyncStatus}
                  loading={frameSyncStatusLoading}
                  applying={frameSyncApplying}
                  error={frameSyncError}
                />
              ) : hasFrameSyncChanges ? (
                <section className="space-y-2">
                  <DrawerHeading
                    action={
                      <button
                        type="button"
                        onClick={() => loadFrameSyncStatus()}
                        disabled={frameSyncStatusLoading}
                        className="frameos-secondary-button rounded-lg px-2.5 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
                      >
                        {frameSyncStatusLoading ? 'Checking' : 'Refresh'}
                      </button>
                    }
                  >
                    Sync changes detected
                  </DrawerHeading>
                  <div className="frame-tool-card rounded-[22px] p-4">
                    <div className="frame-tool-muted text-sm leading-5">
                      The frame reports local changes since the last successful deploy. Checking the detailed diff.
                    </div>
                    {frameSyncError ? (
                      <div className="mt-2 text-sm font-semibold text-red-500">{frameSyncError}</div>
                    ) : null}
                  </div>
                </section>
              ) : deployPlansLoading ? (
                <DeployPlanProgress logs={deployPlanLogs} planReady={false} />
              ) : deployPlansError ? (
                <div className="space-y-3">
                  <DeployPlanProgress error={deployPlansError} logs={deployPlanLogs} planReady={false} />
                  <div className="text-sm font-semibold text-red-500">{deployPlansError}</div>
                  <button
                    type="button"
                    onClick={() => loadDeployPlans()}
                    className="frameos-secondary-button rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <div className="space-y-5">
                  {frameSyncError ? (
                    <section className="space-y-2">
                      <DrawerHeading
                        action={
                          <button
                            type="button"
                            onClick={() => loadFrameSyncStatus()}
                            disabled={frameSyncStatusLoading}
                            className="frameos-secondary-button rounded-lg px-2.5 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
                          >
                            Retry
                          </button>
                        }
                      >
                        Sync unavailable
                      </DrawerHeading>
                      <div className="frame-tool-card rounded-[22px] p-4">
                        <div className="text-sm font-semibold text-amber-600">{frameSyncError}</div>
                      </div>
                    </section>
                  ) : null}
                  {deployRecommendation ? (
                    <section className="space-y-2">
                      <DrawerHeading
                        action={
                          <button
                            type="button"
                            onClick={() => loadDeployPlans()}
                            disabled={deployPlansLoading}
                            className="frameos-secondary-button rounded-lg px-2.5 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
                          >
                            Refresh
                          </button>
                        }
                      >
                        {deployRecommendation.title}
                      </DrawerHeading>
                      <div className="frame-tool-card rounded-[22px] p-4">
                        <div className="frame-tool-muted text-sm leading-5">
                          <RecommendationDescription recommendation={deployRecommendation} />
                        </div>
                      </div>
                    </section>
                  ) : null}
                  {isEmbeddedFrame ? (
                    <EmbeddedFirmwareSection
                      frame={frame}
                      onOtaUpdate={() => closeAndRun(() => applyEmbeddedFirmwareOta(frame.id))}
                    />
                  ) : null}
                  {deployChangeDetails.length > 0 ? (
                    <section className="space-y-2">
                      <DrawerHeading action={<FrameSettingsLink frameId={frame.id} />}>Pending changes</DrawerHeading>
                      <div className="frame-tool-card rounded-[22px] p-4">
                        <ChangeRows changes={deployChangeDetails} />
                      </div>
                    </section>
                  ) : null}
                  {deploySummaryWithoutBuildOptions.length > 0 ? (
                    <section>
                      <SummaryRows items={deploySummaryWithoutBuildOptions} />
                    </section>
                  ) : null}
                  <DeployBuildOptionsSection frame={frame} frameForm={frameForm} />
                </div>
              )}
            </>
          )}
        </div>
        <div className="frameos-divider flex flex-wrap justify-end gap-2 border-t border-slate-200/80 px-5 py-4">
          {isCloud ? (
            // The deploy actions live in the body next to their explanations
            // (a bare footer "Push scenes" button was unexplainable); the
            // footer only closes.
            <button
              type="button"
              onClick={closeDrawer}
              className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Close
            </button>
          ) : (frameForm.embedded?.platform ?? frame.embedded?.platform) === 'virtual' ? (
            <>
              <button
                type="button"
                onClick={closeDrawer}
                className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Close
              </button>
              <button
                type="button"
                title="Save changes and render this frame's scenes now"
                onClick={() => closeAndRun(saveAndFullDeployFrame)}
                className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Deploy
              </button>
            </>
          ) : activeDeployDrawerView !== 'main' ? (
            <button
              type="button"
              onClick={closeOnlyDrawerView ? closeDrawer : showMainDeployView}
              className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              {closeOnlyDrawerView ? 'Close' : 'Cancel'}
            </button>
          ) : hasFrameSyncChanges ? (
            <>
              <button
                type="button"
                onClick={closeDrawer}
                className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => loadFrameSyncStatus()}
                disabled={frameSyncStatusLoading || frameSyncApplying}
                className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => ignoreFrameSyncChanges()}
                disabled={!canIgnoreFrameSyncChanges}
                title="Hide these frame changes and continue to deploy"
                className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
              >
                Ignore frame changes
              </button>
              <button
                type="button"
                onClick={() => applyFrameSync()}
                disabled={frameSyncApplying || !frameSyncStatusReady || !canApplyFrameSync}
                className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
              >
                {frameSyncApplyMode === 'commit' ? <Spinner color="white" /> : null}
                {frameSyncApplyMode === 'commit'
                  ? 'Committing sync changes'
                  : !frameSyncStatusReady
                  ? 'Checking'
                  : canApplyFrameSync
                  ? 'Commit selected choices'
                  : 'Choose changes'}
              </button>
            </>
          ) : (
            <>
              {frame.status === 'deploying' ? (
                <button
                  type="button"
                  title="Abort the running deploy and clear the deploy lock, so a new deploy can start"
                  onClick={() => cancelDeploy(frame.id)}
                  className="rounded-lg px-4 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  Cancel stuck deploy
                </button>
              ) : null}
              <button
                type="button"
                onClick={closeDrawer}
                className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => closeAndRun(saveAndFastDeployFrame)}
                className={clsx(
                  'rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                  deployRecommendation?.mode === 'fast' ? 'frameos-primary-action' : 'frameos-secondary-button'
                )}
              >
                Fast deploy
              </button>
              {!isEmbeddedFrame || embeddedFullDeploySupported ? (
                <button
                  type="button"
                  title={
                    isEmbeddedFrame
                      ? 'Install the latest FrameOS release over the air (OTA), then push the scenes'
                      : undefined
                  }
                  onClick={() => closeAndRun(saveAndFullDeployFrame)}
                  className={clsx(
                    'rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    deployRecommendation?.mode === 'full' ? 'frameos-primary-action' : 'frameos-secondary-button'
                  )}
                >
                  Full deploy
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
