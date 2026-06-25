import { useActions, useMountedLogic, useValues } from 'kea'
import { A as Link } from 'kea-router'
import clsx from 'clsx'
import copy from 'copy-to-clipboard'
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  CloudArrowUpIcon,
  ClipboardDocumentIcon,
  CommandLineIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { useEffect, useState, type ReactNode } from 'react'

import { DropdownMenu } from '../../components/DropdownMenu'
import { FrameConnectionDot } from '../../components/FrameConnectionDot'
import { PartialRefreshSettingsFields } from '../../components/PartialRefreshSettingsFields'
import { Spinner } from '../../components/Spinner'
import { Switch } from '../../components/Switch'
import { TextInput } from '../../components/TextInput'
import { Tooltip } from '../../components/Tooltip'
import { frameHasActivityLog, frameHost } from '../../decorators/frame'
import { buildrootPlatforms, devices, partialRefreshDefaultsByDevice, partialRefreshDevices } from '../../devices'
import { framesModel, type RemoteTaskTransport } from '../../models/framesModel'
import type { FrameOSSettings, FrameType, LogType } from '../../types'
import { urls } from '../../urls'
import { apiFetch } from '../../utils/apiFetch'
import { getDefaultSshKeyIds, normalizeSshKeys } from '../../utils/sshKeys'
import { normalizedTimezone } from '../../utils/timezone'
import {
  frameLogic,
  type ChangeDetail,
  type DeployDrawerView,
  type DeployRecommendation,
  type SummaryItem,
} from '../frame/frameLogic'
import { buildRemoteUpgradeNotice, frameosGitHubReleaseUrl, type RemoteUpgradeNotice } from '../frame/frameDeployUtils'
import { frameCompilationModeOptions } from '../../utils/frameBuildOptions'
import { logsLogic } from '../frame/panels/Logs/logsLogic'
import { settingsLogic } from '../settings/settingsLogic'
import { EmbeddedWebFlasher } from './EmbeddedWebFlasher'
import { frameBootstrapLogic } from './frameBootstrapLogic'
import { workspaceLogic } from './workspaceLogic'
import { timezoneOptions } from '../../decorators/timezones'

interface DeployPlanProgressStep {
  label: string
  detail?: string | null
  state: 'done' | 'current' | 'pending' | 'error'
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
      FrameOS upgrade{' '}
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

function FrameSettingsLink({ frameId }: { frameId: number }): JSX.Element {
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
  frameId: number
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
  const remoteUpgradeTitle = remoteUpgradeNotice ? `FrameOS Remote ${remoteUpgradeLabel(remoteUpgradeNotice)}` : undefined

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
                  SSH needs direct network access from the backend to the frame. FrameOS Remote runs on the frame, and
                  keeps a connection open to the backend.
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
  const platform = buildroot.platform ?? 'raspberry-pi-zero-2-w'
  const compilationMode = String(buildroot.compilationMode ?? '')
  const rootPassword = frameForm.ssh_pass ?? frame.ssh_pass ?? ''
  const sshKeyOptions = normalizeSshKeys(savedSettings.ssh_keys).keys
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
            {sshKeyOptions.length === 0 ? (
              <div className="text-sm text-slate-500">No SSH keys configured in settings.</div>
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
                        updateFrameValue('ssh_keys', Array.from(next))
                      }}
                    />
                    <div className="min-w-0 flex-1 truncate text-sm text-slate-700">{key.name || key.id}</div>
                  </div>
                ))}
              </div>
            )}
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

interface FrameBootstrapApiResponse {
  command: string
}

function ScriptInstallSection({ frame, onBack }: { frame: FrameType; onBack: () => void }): JSX.Element {
  const { loadFrame } = useActions(framesModel)
  const [command, setCommand] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadCommand = async (regenerate = false): Promise<void> => {
    setLoading(true)
    setCopied(false)
    setError(null)
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

function EmbeddedFirmwareSection({
  frame,
  onBack,
  onDownload,
  onOtaUpdate,
}: {
  frame: FrameType
  onBack?: () => void
  onDownload: () => void
  onOtaUpdate: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [browserFlashBusy, setBrowserFlashBusy] = useState(false)
  const firmware = frame.embedded?.firmware
  const platformLabel = frame.embedded?.platform || 'esp32-s3'
  const filename = firmware?.filename || `frameos-esp32-s3-frame${frame.id}.bin`
  const flashCommand = `esptool.py --chip esp32s3 --port /dev/tty.usbmodem* --baud 460800 --flash_size 8MB write_flash ${
    firmware?.flashOffset || '0x0'
  } ${filename}`
  const building = firmware?.status === 'building' || firmware?.status === 'queued'
  const otaBuilding = building && !browserFlashBusy

  const copyFlashCommand = (): void => {
    copy(flashCommand)
    setCopied(true)
  }

  return (
    <section className="mb-5 space-y-2">
      <DrawerHeading action={<FrameSettingsLink frameId={frame.id} />}>
        <span className="inline-flex items-center gap-2">
          {onBack ? <BackToDeployButton onClick={onBack} /> : null}
          <span>Firmware</span>
        </span>
      </DrawerHeading>
      <div className="mb-3">
        <div className="frame-tool-muted mt-1 text-sm leading-5">
          Download a firmware image for the {platformLabel.toUpperCase()} and flash it over USB serial. The firmware
          runs the embedded FrameOS runtime and can hot-load interpreted scenes after it checks in.
        </div>
        {firmware?.status ? (
          <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">
            Status: {firmware.status}
          </div>
        ) : null}
        {firmware?.error ? <div className="mt-2 text-sm font-semibold text-red-500">{firmware.error}</div> : null}
      </div>
      <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
        <div className="frame-tool-muted text-sm leading-5">
          Plug the board into this computer over USB, then flash it straight from the browser. The firmware is built on
          demand, so the first flash can take a minute.
        </div>
        <EmbeddedWebFlasher frame={frame} onBusyChange={setBrowserFlashBusy} />
      </div>
      <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[color:var(--tool-strong)]">Over-the-air update</div>
            <div className="frame-tool-muted mt-1 text-sm leading-5">
              Build the latest app image, then ask the frame to pull it from this backend and reboot.
            </div>
          </div>
          <button
            type="button"
            onClick={onOtaUpdate}
            disabled={browserFlashBusy}
            className="frameos-primary-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
          >
            {otaBuilding ? <Spinner color="white" /> : <CloudArrowUpIcon className="h-4 w-4" />}
            {otaBuilding ? 'Finish build & update' : 'Update over the air'}
          </button>
        </div>
      </div>
      <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
        <div className="frame-tool-muted text-sm leading-5">
          Or download the image and flash it by hand (<code>pip install esptool</code> if you don't have it):
        </div>
        <pre className="frameos-inset whitespace-pre-wrap break-all rounded-xl border p-3 text-xs leading-5 text-[color:var(--tool-strong)]">
          <code>{flashCommand}</code>
        </pre>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onDownload}
            disabled={building}
            className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
          >
            {building ? <Spinner /> : <ArrowDownTrayIcon className="h-4 w-4" />}
            {building ? 'Building firmware' : 'Build & download firmware'}
          </button>
          <button
            type="button"
            onClick={copyFlashCommand}
            className="frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <ClipboardDocumentIcon className="h-4 w-4" />
            {copied ? 'Copied' : 'Copy flash command'}
          </button>
        </div>
      </div>
    </section>
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
    fullDeployPlanSummary,
  } = useValues(frameLogic({ frameId: frame.id }))
  const {
    hideDeployPlanModal,
    deployRemote,
    loadDeployPlans,
    restartRemote,
    saveAndFastDeployFrame,
    saveAndFullDeployFrame,
    setDeployDrawerView,
    setDeployWithAgent,
  } = useActions(frameLogic({ frameId: frame.id }))
  const { closeFrameChangeDrawer } = useActions(workspaceLogic)
  const { applyEmbeddedFirmwareOta, cancelDeploy, downloadEmbeddedFirmware, downloadSdCardImage, loadFrame } =
    useActions(framesModel)
  const { logs } = useValues(logsLogic({ frameId: frame.id }))
  const { savedSettings } = useValues(settingsLogic)
  const defaultTimezone = savedSettings.defaults?.timezone

  const deployPlanLogs = deployPlanLogsSince(logs, deployPlansLoadingStartedAt)
  const isBuildrootFrame = (frame.mode ?? 'rpios') === 'buildroot'
  const isEmbeddedFrame = (frame.mode ?? 'rpios') === 'embedded'
  const embeddedFastDeployReady = isEmbeddedFrame && frameHasActivityLog(frame)
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
  const showMainDeployView = (): void => setDeployDrawerView('main')
  const deploySummaryWithoutBuildOptions = fullDeployPlanSummary.filter(
    (item) => item.label !== 'Build strategy' && item.label !== 'Compilation'
  )

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
            <h2 className="frameos-strong truncate text-xl font-bold tracking-normal text-slate-950">Deploy</h2>
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
          {activeDeployDrawerView === 'embedded' ? (
            <EmbeddedFirmwareSection
              frame={frame}
              onBack={embeddedFastDeployReady ? showMainDeployView : undefined}
              onDownload={() => closeAndRun(() => downloadEmbeddedFirmware(frame.id))}
              onOtaUpdate={() => closeAndRun(() => applyEmbeddedFirmwareOta(frame.id))}
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
              {!isEmbeddedFrame ? <AlternativesSection onSelect={setDeployDrawerView} /> : null}
              {canBootstrapFrameOS ? (
                <div className="mb-4">
                  <FrameBootstrapAction frame={frame} />
                </div>
              ) : null}
              {deployTransportToggleVisible && !firstInstall ? (
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
              {deployPlansLoading ? (
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
          {activeDeployDrawerView !== 'main' ? (
            <button
              type="button"
              onClick={closeOnlyDrawerView ? closeDrawer : showMainDeployView}
              className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              {closeOnlyDrawerView ? 'Close' : 'Cancel'}
            </button>
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
              {isEmbeddedFrame ? (
                <button
                  type="button"
                  onClick={() => setDeployDrawerView('embedded')}
                  className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  Firmware
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => closeAndRun(saveAndFullDeployFrame)}
                  className={clsx(
                    'rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    deployRecommendation?.mode === 'full' ? 'frameos-primary-action' : 'frameos-secondary-button'
                  )}
                >
                  Full deploy
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
