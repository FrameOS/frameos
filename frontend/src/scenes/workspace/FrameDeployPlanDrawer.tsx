import { useActions, useMountedLogic, useValues } from 'kea'
import { A as Link } from 'kea-router'
import clsx from 'clsx'
import copy from 'copy-to-clipboard'
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  CommandLineIcon,
  ServerStackIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { useEffect, useState, type ReactNode } from 'react'

import { DropdownMenu } from '../../components/DropdownMenu'
import { FrameConnectionDot } from '../../components/FrameConnectionDot'
import { Spinner } from '../../components/Spinner'
import { TextInput } from '../../components/TextInput'
import { Tooltip } from '../../components/Tooltip'
import { frameHost } from '../../decorators/frame'
import { buildrootPlatforms, devices } from '../../devices'
import { framesModel, type AgentTaskTransport } from '../../models/framesModel'
import type { FrameType, LogType } from '../../types'
import { urls } from '../../urls'
import { apiFetch } from '../../utils/apiFetch'
import { normalizedTimezone } from '../../utils/timezone'
import {
  frameLogic,
  type ChangeDetail,
  type DeployDrawerView,
  type DeployRecommendation,
  type SummaryItem,
} from '../frame/frameLogic'
import { CURRENT_FRAMEOS_VERSION } from '../frame/frameDeployUtils'
import { logsLogic } from '../frame/panels/Logs/logsLogic'
import { settingsLogic } from '../settings/settingsLogic'
import { agentBootstrapLogic } from './agentBootstrapLogic'
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

  if (log.type === 'agent') {
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
          <span className="min-w-0 flex-1 truncate text-[color:var(--tool-strong)]">{change.label}</span>
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

function FirstInstallSection(): JSX.Element {
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <DrawerHeading>First install</DrawerHeading>
        <div className="frame-tool-card rounded-[22px] p-4">
          <div className="frame-tool-muted text-sm leading-5">
            This frame has not reported a successful deploy yet. Install it over SSH, run the install script on the
            device, or download an SD card image. After the frame has been installed, this drawer will show redeploy
            changes.
          </div>
        </div>
      </section>
      <section>
        <SummaryRows items={[{ label: 'FrameOS version', value: CURRENT_FRAMEOS_VERSION }]} />
      </section>
    </div>
  )
}

function FirstInstallOptionsSection({
  onDownloadSdCard,
  onRunScript,
  onDeploySsh,
}: {
  onDownloadSdCard: () => void
  onRunScript: () => void
  onDeploySsh: () => void
}): JSX.Element {
  const buttonClassName =
    'frameos-secondary-button flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

  return (
    <section className="mb-4 space-y-2">
      <DrawerHeading>Install options</DrawerHeading>
      <div className="space-y-2">
        <button type="button" onClick={onDeploySsh} className={buttonClassName}>
          <span className="flex min-w-0 items-center gap-2">
            <ServerStackIcon className="h-5 w-5 shrink-0" />
            <span className="truncate">Deploy via SSH</span>
          </span>
          <ChevronRightIcon className="h-4 w-4 shrink-0 opacity-60" />
        </button>
        <button type="button" onClick={onRunScript} className={buttonClassName}>
          <span className="flex min-w-0 items-center gap-2">
            <CommandLineIcon className="h-5 w-5 shrink-0" />
            <span className="truncate">Run a script</span>
          </span>
          <ChevronRightIcon className="h-4 w-4 shrink-0 opacity-60" />
        </button>
        <button type="button" onClick={onDownloadSdCard} className={buttonClassName}>
          <span className="flex min-w-0 items-center gap-2">
            <ArrowDownTrayIcon className="h-5 w-5 shrink-0" />
            <span className="truncate">Download SD card</span>
          </span>
          <ChevronRightIcon className="h-4 w-4 shrink-0 opacity-60" />
        </button>
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

function DeployTransportToggle({
  frameId,
  agentConnected,
  canDeployAgent,
  canCopyBootstrapScript,
  showRecompileAgent,
  onDeployAgent,
  onRestartAgent,
  deployWithAgent,
  onChange,
}: {
  frameId: number
  agentConnected: boolean
  canDeployAgent: boolean
  canCopyBootstrapScript: boolean
  showRecompileAgent: boolean
  onDeployAgent: (recompile?: boolean, transport?: AgentTaskTransport) => void
  onRestartAgent: (transport?: AgentTaskTransport) => void
  deployWithAgent: boolean
  onChange: (deployWithAgent: boolean) => void
}): JSX.Element {
  const bootstrapLogicProps = { frameId }
  const { copied: bootstrapCopied, loading: bootstrapLoading } = useValues(agentBootstrapLogic(bootstrapLogicProps))
  const { copyAgentBootstrapScript } = useActions(agentBootstrapLogic(bootstrapLogicProps))
  const selectedTransport: AgentTaskTransport = deployWithAgent ? 'agent' : 'ssh'
  const selectedConnectionLabel = deployWithAgent ? 'agent' : 'SSH'
  const selectedAgentDisconnected = selectedTransport === 'agent' && !agentConnected
  const selectedConnectionUnavailableTitle =
    'The FrameOS agent is not connected. Select SSH or wait for the agent to connect.'
  const selectedConnectionTitle = `Use the selected ${selectedConnectionLabel} connection`

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
                  SSH needs direct network access from the backend to the frame. The agent runs on the frame, and keeps
                  a connection open to the backend.
                </div>
                <div>
                  To use the agent, enable it under{' '}
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
              title={agentConnected ? 'FrameOS agent connected' : 'FrameOS agent not connected'}
              onClick={() => onChange(true)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                deployWithAgent ? 'frameos-primary-action' : 'frameos-secondary-button'
              )}
            >
              {agentConnected ? (
                <FrameConnectionDot size="sm" title="FrameOS agent connected" />
              ) : (
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full bg-slate-300 ring-1 ring-inset ring-slate-400/50"
                />
              )}
              <span>Agent</span>
            </button>
          </div>
          <DropdownMenu
            buttonColor="none"
            horizontal
            className="frameos-secondary-button flex h-9 w-9 items-center justify-center rounded-xl !px-0 !py-0 !shadow-none transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            items={[
              ...(canCopyBootstrapScript
                ? [
                    {
                      label: bootstrapCopied ? 'Bootstrap copied' : 'Copy bootstrap command',
                      title: 'Copy agent bootstrap install command',
                      loading: bootstrapLoading,
                      onClick: () => copyAgentBootstrapScript(false),
                    },
                  ]
                : []),
              {
                label: 'Restart agent',
                title: selectedAgentDisconnected ? selectedConnectionUnavailableTitle : selectedConnectionTitle,
                disabled: selectedAgentDisconnected,
                onClick: () => onRestartAgent(selectedTransport),
              },
              ...(canDeployAgent
                ? [
                    {
                      label: 'Deploy agent',
                      title: selectedAgentDisconnected ? selectedConnectionUnavailableTitle : selectedConnectionTitle,
                      disabled: selectedAgentDisconnected,
                      onClick: () => onDeployAgent(false, selectedTransport),
                    },
                    ...(showRecompileAgent
                      ? [
                          {
                            label: 'Recompile and deploy agent',
                            title: selectedAgentDisconnected
                              ? selectedConnectionUnavailableTitle
                              : selectedConnectionTitle,
                            disabled: selectedAgentDisconnected,
                            onClick: () => onDeployAgent(true, selectedTransport),
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

function AgentBootstrapHelp(): JSX.Element {
  return (
    <Tooltip
      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-amber-500 hover:text-amber-600"
      titleClassName="w-72"
      title="Use this when the frame can reach this backend but SSH is unavailable. Run the command on the frame as root to install FrameOS and connect the agent."
    >
      <ExclamationCircleIcon className="h-4 w-4" aria-label="Agent bootstrap help" />
    </Tooltip>
  )
}

function AgentBootstrapAction({ frame }: { frame: FrameType }): JSX.Element | null {
  const logicProps = { frameId: frame.id }
  const { copied, error, loading } = useValues(agentBootstrapLogic(logicProps))
  const { copyAgentBootstrapScript } = useActions(agentBootstrapLogic(logicProps))

  if (frame.last_successful_deploy_at || (frame.mode ?? 'rpios') !== 'rpios') {
    return null
  }

  return (
    <section className="space-y-2">
      <DrawerHeading>
        <span className="inline-flex items-center gap-1.5">
          <span>Agent bootstrap</span>
          <AgentBootstrapHelp />
        </span>
      </DrawerHeading>
      <button
        type="button"
        onClick={() => copyAgentBootstrapScript()}
        disabled={loading}
        className="frameos-secondary-button flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ClipboardDocumentIcon className="h-5 w-5 shrink-0" />
          <span className="truncate">{copied ? 'Agent bootstrap script copied' : 'Copy agent bootstrap script'}</span>
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
  const network = frameForm.network ?? frame.network ?? {}
  const buildroot = frameForm.buildroot ?? frame.buildroot ?? {}
  const serverHost = frameForm.server_host ?? frame.server_host ?? ''
  const serverPort = frameForm.server_port ?? frame.server_port ?? 8989
  const device = frameForm.device ?? frame.device ?? 'web_only'
  const timezone = normalizedTimezone(frameForm.timezone ?? frame.timezone, defaultTimezone)
  const platform = buildroot.platform ?? 'raspberry-pi-zero-2-w'
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

  return (
    <section className="mb-5 space-y-2">
      <DrawerHeading
        action={
          <Link
            href={`${urls.frame(frame.id, 'settings')}#frame-settings-network`}
            className="frameos-link text-xs font-semibold underline underline-offset-2 hover:no-underline"
          >
            More settings
          </Link>
        }
      >
        <span className="inline-flex items-center gap-2">
          {onBack ? <BackToDeployButton onClick={onBack} /> : null}
          <span>Buildroot SD card</span>
        </span>
      </DrawerHeading>
      <div className="frame-tool-card space-y-4 rounded-[22px] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="frame-tool-heading text-sm font-semibold">SD card image</div>
            <div className="frame-tool-muted mt-1 text-sm leading-5">
              Prepare a flashable Raspberry Pi Zero 2 W image from the cached Buildroot base and the current FrameOS
              release.
            </div>
            {frame.buildroot?.sdImage?.status ? (
              <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">
                Status: {frame.buildroot.sdImage.status}
              </div>
            ) : null}
          </div>
        </div>
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

interface AgentBootstrapApiResponse {
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
        `/api/frames/${frame.id}/agent_bootstrap?select_agent=1&regenerate=${regenerate ? 1 : 0}`,
        {
          method: 'POST',
        }
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(typeof payload?.detail === 'string' ? payload.detail : 'Failed to create install command')
      }
      const payload = (await response.json()) as AgentBootstrapApiResponse
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
          Run this command on the device as a user with sudo access. It installs FrameOS, starts the agent, and connects
          back to this backend.
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

export function FrameDeployPlanDrawer({ frame }: { frame: FrameType }): JSX.Element | null {
  useMountedLogic(logsLogic({ frameId: frame.id }))
  const {
    agentDeployConnected,
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
    deployAgent,
    loadDeployPlans,
    restartAgent,
    saveAndFastDeployFrame,
    saveAndFullDeployFrame,
    setDeployDrawerView,
    setDeployWithAgent,
  } = useActions(frameLogic({ frameId: frame.id }))
  const { closeFrameChangeDrawer } = useActions(workspaceLogic)
  const { downloadSdCardImage, loadFrame } = useActions(framesModel)
  const { logs } = useValues(logsLogic({ frameId: frame.id }))
  const { savedSettings } = useValues(settingsLogic)
  const defaultTimezone = savedSettings.defaults?.timezone

  const deployPlanLogs = deployPlanLogsSince(logs, deployPlansLoadingStartedAt)
  const isBuildrootFrame = (frame.mode ?? 'rpios') === 'buildroot'
  const hasSuccessfulDeploy = Boolean(frame.last_successful_deploy_at || frame.last_successful_deploy)
  const firstInstall = !hasSuccessfulDeploy
  const directSdCardFirstInstall = firstInstall && isBuildrootFrame && deployDrawerView === 'main'
  const activeDeployDrawerView = directSdCardFirstInstall ? 'sdCard' : deployDrawerView
  const canDeployAgent = true
  const canCopyBootstrapScript = !isBuildrootFrame
  const canBootstrapAgent = !firstInstall && !frame.last_successful_deploy_at && !isBuildrootFrame
  const showRecompileAgent = import.meta.env?.DEV === true
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

  const saveSdCardSettingsAndDownload = async (): Promise<void> => {
    const response = await apiFetch(`/api/frames/${frame.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'buildroot',
        assets_path: '/srv/assets',
        device: frameForm.device ?? frame.device,
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
          {activeDeployDrawerView === 'sdCard' ? (
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
              {firstInstall ? (
                <FirstInstallOptionsSection
                  onDeploySsh={() => closeAndRun(saveAndFullDeployFrame)}
                  onRunScript={() => setDeployDrawerView('script')}
                  onDownloadSdCard={() => setDeployDrawerView('sdCard')}
                />
              ) : (
                <AlternativesSection onSelect={setDeployDrawerView} />
              )}
              {canBootstrapAgent ? (
                <div className="mb-4">
                  <AgentBootstrapAction frame={frame} />
                </div>
              ) : null}
              {deployTransportToggleVisible && !firstInstall ? (
                <DeployTransportToggle
                  frameId={frame.id}
                  agentConnected={agentDeployConnected}
                  canDeployAgent={canDeployAgent}
                  canCopyBootstrapScript={canCopyBootstrapScript}
                  showRecompileAgent={showRecompileAgent}
                  onDeployAgent={deployAgent}
                  onRestartAgent={restartAgent}
                  deployWithAgent={deployWithAgent}
                  onChange={setDeployWithAgent}
                />
              ) : null}
              {firstInstall ? (
                <FirstInstallSection />
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
                      <DrawerHeading>Pending changes</DrawerHeading>
                      <div className="frame-tool-card rounded-[22px] p-4">
                        <ChangeRows changes={deployChangeDetails} />
                      </div>
                    </section>
                  ) : null}
                  {fullDeployPlanSummary.length > 0 ? (
                    <section>
                      <SummaryRows items={fullDeployPlanSummary} />
                    </section>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
        <div className="frameos-divider flex flex-wrap justify-end gap-2 border-t border-slate-200/80 px-5 py-4">
          {activeDeployDrawerView !== 'main' ? (
            <button
              type="button"
              onClick={directSdCardFirstInstall ? closeDrawer : showMainDeployView}
              className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              {directSdCardFirstInstall ? 'Close' : 'Cancel'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={closeDrawer}
                className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Close
              </button>
              {firstInstall ? (
                <>
                  <button
                    type="button"
                    onClick={() => setDeployDrawerView('sdCard')}
                    className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    Download SD card
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeployDrawerView('script')}
                    className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    Run a script
                  </button>
                  <button
                    type="button"
                    onClick={() => closeAndRun(saveAndFullDeployFrame)}
                    className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    Deploy via SSH
                  </button>
                </>
              ) : isBuildrootFrame ? (
                <button
                  type="button"
                  onClick={() => closeAndRun(saveAndFastDeployFrame)}
                  className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  Deploy updates
                </button>
              ) : (
                <>
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
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
