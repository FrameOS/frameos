import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import type { ChangeEvent, DragEvent, ReactNode } from 'react'

import { Spinner } from '../../../frontend/src/components/Spinner'
import { ESP32_HARDWARE_PRESET_CONFIGS } from '../../../frontend/src/scenes/frame/panels/FrameSettings/esp32Hardware'
import { esp32Panels } from '../lib/generated-devices'
import { FLASHER_FRAME_ID, flasherLogic } from './flasherLogic'
import { CUSTOM_BOARD, standaloneBoard, standaloneBoards, standaloneHostname } from './standalone'

// flash.frameos.net's page (cloud/docs/flasher.md). Words and layout only:
// what it does is flasherLogic's.

const primaryButtonClass =
  'frameos-primary-action inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'
const secondaryButtonClass =
  'frameos-secondary-button inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40'
const inputClass =
  'frameos-inset w-full rounded-lg border px-3 py-2 text-sm text-[color:var(--tool-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
const mutedClass = 'frame-tool-muted text-sm leading-6'

function Card({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="frame-tool-card space-y-4 rounded-[22px] p-5">
      {title ? <h2 className="text-base font-semibold text-[color:var(--tool-strong)]">{title}</h2> : null}
      {children}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-[color:var(--tool-strong)]">{label}</span>
      {children}
      {hint ? <span className="frame-tool-muted block text-xs leading-5">{hint}</span> : null}
    </label>
  )
}

function settingValue(settings: { key: string; value: string }[], key: string): string | null {
  return settings.find((setting) => setting.key === key)?.value ?? null
}

function RunStatus(): JSX.Element | null {
  const { phase, message, progress } = useValues(flasherLogic)
  if (!message && phase === 'idle') {
    return null
  }
  return (
    <div className="space-y-2">
      {phase === 'flashing' && progress !== null ? (
        <div className="frameos-inset h-2 w-full overflow-hidden rounded-full border">
          <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {message ? (
        <div
          className={clsx(
            'flex items-start gap-2 text-sm leading-6',
            phase === 'error'
              ? 'font-semibold text-red-500'
              : phase === 'done'
                ? 'font-semibold text-green-600'
                : 'text-[color:var(--tool-strong)]'
          )}
        >
          {phase === 'connecting' || phase === 'preparing' || phase === 'flashing' ? (
            <span className="mt-1">
              <Spinner />
            </span>
          ) : null}
          <span>{message}</span>
        </div>
      ) : null}
    </div>
  )
}

function JobCard(): JSX.Element | null {
  const { job, jobFrom, mode, busy, usbSupported } = useValues(flasherLogic)
  const { runSetup, runUpdate, runProvision, setJob, setMode } = useActions(flasherLogic)
  if (!job) {
    return null
  }
  const { setup } = job
  const settings = setup.provisioning.settings
  const backend = settingValue(settings, 'backend') ?? setup.backend?.url ?? null
  const preset = settingValue(settings, 'hardware')
  const board = preset
    ? ((ESP32_HARDWARE_PRESET_CONFIGS as Record<string, { label: string } | undefined>)[preset]?.label ?? preset)
    : settingValue(settings, 'panel')
  const pico = setup.provisioning.releaseFormat === 'uf2'
  const fromHost = (() => {
    try {
      return jobFrom && mode === 'bridge' ? new URL(jobFrom).host : jobFrom
    } catch {
      return jobFrom
    }
  })()
  return (
    <Card title={`Set up “${setup.frame.name}”`}>
      <div className={mutedClass}>
        {mode === 'bridge' ? (
          <>
            The FrameOS page at <strong className="text-[color:var(--tool-strong)]">{jobFrom}</strong> asked this
            flasher to do its USB part. Check what will be written: nothing happens until you click below and pick the
            board’s port.
          </>
        ) : (
          <>
            From the setup file <strong className="text-[color:var(--tool-strong)]">{fromHost}</strong>. Nothing happens
            until you click below and pick the board’s port.
          </>
        )}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="frame-tool-muted">Frame</dt>
        <dd className="font-semibold">
          {setup.frame.name} (#{String(setup.frame.id)})
        </dd>
        <dt className="frame-tool-muted">Calls home to</dt>
        <dd className="break-all font-semibold">{backend ?? 'nothing (no backend set)'}</dd>
        {backend && mode === 'bridge' && jobFrom && !backend.startsWith(jobFrom) ? (
          <>
            <dt />
            <dd className="frame-tool-muted text-xs leading-5">
              That is not the address of the page that asked. Fine when the frame reaches its backend by another name;
              stop here if you did not expect it.
            </dd>
          </>
        ) : null}
        <dt className="frame-tool-muted">Board</dt>
        <dd className="font-semibold">{board ?? setup.provisioning.platform ?? 'as configured'}</dd>
        <dt className="frame-tool-muted">Wi-Fi</dt>
        <dd className="font-semibold">{setup.provisioning.wifi?.ssid ?? 'none (the board asks on its first boot)'}</dd>
        <dt className="frame-tool-muted">Scenes</dt>
        <dd className="font-semibold">{setup.scenes.length}</dd>
        <dt className="frame-tool-muted">Settings</dt>
        <dd className="font-semibold">{settings.length} console settings</dd>
      </dl>
      {setup.provisioning.warnings.length > 0 ? (
        <ul className="frame-tool-muted list-disc space-y-0.5 pl-5 text-xs leading-5">
          {setup.provisioning.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {!setup.provisioning.supported ? (
        <div className="text-sm font-semibold text-red-500">
          This frame cannot be set up yet: {setup.provisioning.blockers.join(' ')}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {pico || job.kind === 'provision' ? (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={busy || !usbSupported}
              onClick={runProvision}
            >
              Send the settings{job.withWifi && setup.provisioning.wifi ? ' and Wi-Fi' : ''}
            </button>
          ) : job.kind === 'update' ? (
            <button type="button" className={primaryButtonClass} disabled={busy || !usbSupported} onClick={runUpdate}>
              Update the firmware, keep its settings
            </button>
          ) : (
            <button type="button" className={primaryButtonClass} disabled={busy || !usbSupported} onClick={runSetup}>
              Flash FrameOS & set up {setup.frame.name}
            </button>
          )}
          {mode === 'file' && !pico ? (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy || !usbSupported}
              onClick={runProvision}
            >
              Only send the settings (it runs FrameOS already)
            </button>
          ) : null}
          {mode === 'file' ? (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() => {
                setJob(null, null)
                setMode('standalone')
              }}
            >
              Close the file
            </button>
          ) : null}
        </div>
      )}
      {pico ? (
        <div className="frame-tool-muted text-xs leading-5">
          A Pico takes its firmware as a .uf2 file dropped onto its BOOTSEL drive, from the backend. Once it runs
          FrameOS, plug it in here to send its settings.
        </div>
      ) : null}
      <RunStatus />
    </Card>
  )
}

function StandaloneCard(): JSX.Element {
  const {
    board,
    panel,
    pins,
    name,
    ssid,
    password,
    timeZone,
    templates,
    templatesError,
    picked,
    busy,
    usbSupported,
    standaloneIssue,
    choices,
  } = useValues(flasherLogic)
  const { setBoard, setPanel, setPins, setName, setSsid, setPassword, setTimeZone, togglePicked, runSetup } =
    useActions(flasherLogic)
  const chosen = standaloneBoard(board)
  const custom = board === CUSTOM_BOARD
  return (
    <Card title="A standalone frame">
      <div className={mutedClass}>
        An ESP32-S3 frame of its own: no backend and no account. It shows the scenes you pick here, installs more from
        the Scene store scene on the frame, and keeps working offline. Its settings change over USB, from this page.
      </div>
      <Field
        label="Board"
        hint={
          chosen?.touch
            ? 'A touch board: you can also join a network later on its own screen (swipe down from the top, then the gear).'
            : 'ESP32-C3 boards and Inky Frames need a backend to draw for them, so they are not here.'
        }
      >
        <select className={inputClass} value={board} onChange={(event) => setBoard(event.target.value)}>
          <option value="">Choose your board…</option>
          {standaloneBoards.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
          <option value={CUSTOM_BOARD}>Other ESP32-S3 board (pick the panel)</option>
        </select>
      </Field>
      {custom || chosen?.panelSelectable ? (
        <Field
          label="Panel"
          hint={custom ? 'The e-paper or display wired to the board.' : 'The panel plugged into the board.'}
        >
          <select className={inputClass} value={choices.panel} onChange={(event) => setPanel(event.target.value)}>
            <option value="">Choose the panel…</option>
            {esp32Panels.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {custom ? (
        <Field
          label="Pins (optional)"
          hint="Empty keeps the Seeed XIAO ESP32-S3 wiring. Otherwise: rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1"
        >
          <input className={inputClass} value={pins} onChange={(event) => setPins(event.target.value)} />
        </Field>
      ) : null}
      <Field label="Name" hint={`On your network as ${standaloneHostname(name)}.`}>
        <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Wi-Fi network">
          <input
            className={inputClass}
            value={ssid}
            autoComplete="off"
            onChange={(event) => setSsid(event.target.value)}
          />
        </Field>
        <Field label="Wi-Fi password">
          <input
            className={inputClass}
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
      </div>
      <Field label="Time zone" hint="From this browser. An IANA name such as Europe/Brussels.">
        <input
          className={inputClass}
          value={timeZone ?? ''}
          onChange={(event) => setTimeZone(event.target.value.trim() || null)}
        />
      </Field>
      <div className="space-y-2">
        <div className="text-sm font-semibold text-[color:var(--tool-strong)]">Scenes to start with</div>
        {templatesError ? <div className="text-xs font-semibold text-red-500">{templatesError}</div> : null}
        {templates === null && !templatesError ? <Spinner /> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {(templates ?? []).map((template) => (
            <label
              key={template.name}
              className="frameos-inset flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.includes(template.name)}
                onChange={() => togglePicked(template.name)}
              />
              <span>
                <span className="block font-semibold text-[color:var(--tool-strong)]">{template.name}</span>
                <span className="frame-tool-muted block text-xs leading-5">{template.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy || !usbSupported || Boolean(standaloneIssue)}
          onClick={runSetup}
        >
          Flash FrameOS & set it up
        </button>
        {standaloneIssue && board ? <span className="frame-tool-muted text-xs">{standaloneIssue}</span> : null}
      </div>
      <div className="frame-tool-muted text-xs leading-5">
        Writes the latest signed FrameOS release for the board’s chip and flash size (checked against the release
        signature first), then sends these settings, your Wi-Fi and the scenes over the cable. A new board formats its
        storage on its first boot: up to a few minutes on a 32 MB board. Keep it plugged in.
      </div>
      <RunStatus />
    </Card>
  )
}

function SetupFileCard(): JSX.Element {
  const { problem, busy } = useValues(flasherLogic)
  const { openSetupFile } = useActions(flasherLogic)
  const open = (files: FileList | null): void => {
    const file = files?.[0]
    if (file) {
      openSetupFile(file)
    }
  }
  return (
    <Card title="A setup file from your backend">
      <div
        className="frameos-inset rounded-xl border border-dashed p-5 text-center"
        onDragOver={(event: DragEvent) => event.preventDefault()}
        onDrop={(event: DragEvent) => {
          event.preventDefault()
          open(event.dataTransfer.files)
        }}
      >
        <div className={mutedClass}>
          Drop a <code>.frameos-setup.json</code> here (a frame’s USB card on your FrameOS backend: Download setup
          file), or
        </div>
        <label className={clsx(secondaryButtonClass, 'mt-2 cursor-pointer')}>
          choose the file
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            disabled={busy}
            onChange={(event: ChangeEvent<HTMLInputElement>) => open(event.target.files)}
          />
        </label>
      </div>
      <div className="frame-tool-muted text-xs leading-5">
        The file stays in this browser: it is read here and its settings go over the USB cable, nowhere else. It holds
        the frame’s API key and Wi-Fi password, so delete it when you are done.
      </div>
      {problem ? <div className="text-sm font-semibold text-red-500">{problem}</div> : null}
    </Card>
  )
}

function BoardToolsCard(): JSX.Element {
  const { boardConnected, toolSsid, toolPassword, toolBusy, toolMessage, busy, usbLogs, usbSupported, lastRun } =
    useValues(flasherLogic)
  const { connectBoard, disconnectBoard, setToolSsid, setToolPassword, applyToolWifi, restartBoard, runUpdate } =
    useActions(flasherLogic)
  return (
    <Card title="Board tools">
      <div className={mutedClass}>
        For a board that already runs FrameOS: read its log, give it another Wi-Fi network, update its firmware while it
        keeps its settings and scenes.
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={busy || !usbSupported}
          onClick={boardConnected ? disconnectBoard : connectBoard}
        >
          {boardConnected ? 'Disconnect' : 'Connect to a board'}
        </button>
        <button type="button" className={secondaryButtonClass} disabled={busy || !usbSupported} onClick={runUpdate}>
          Update firmware, keep settings
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={busy || !usbSupported || (!boardConnected && !lastRun)}
          onClick={restartBoard}
        >
          {toolBusy ? <Spinner /> : null}
          Restart
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Wi-Fi network">
          <input className={inputClass} value={toolSsid} onChange={(event) => setToolSsid(event.target.value)} />
        </Field>
        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={toolPassword}
            onChange={(event) => setToolPassword(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={busy || !usbSupported || !toolSsid.trim()}
          onClick={applyToolWifi}
        >
          Set Wi-Fi
        </button>
      </div>
      {toolMessage ? <div className="text-sm leading-6 text-[color:var(--tool-strong)]">{toolMessage}</div> : null}
      <div className="space-y-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tool-strong)]">USB log</div>
        <pre
          className="max-h-80 overflow-auto rounded-xl border p-3 text-xs leading-5"
          style={{
            background: 'var(--tool-terminal-bg)',
            borderColor: 'var(--tool-terminal-border)',
            color: '#e2e8f0',
          }}
          data-frame={FLASHER_FRAME_ID}
        >
          {usbLogs.length > 0
            ? usbLogs
                .slice(-400)
                .map((log) => log.line)
                .join('\n')
            : 'Nothing yet.'}
        </pre>
      </div>
    </Card>
  )
}

export function FlasherApp(): JSX.Element {
  const { mode, job, waitingForBridge, problem, usbSupported, usbBlockedHere } = useValues(flasherLogic)
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.frameosTheme === 'dark'
  return (
    <div className={clsx('frame-tool-panel min-h-screen', dark && 'frameos-theme-dark')}>
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-8">
        <header className="space-y-2">
          <div className="flex items-center gap-3">
            <img src={dark ? '/logo-dark.svg' : '/logo-light.svg'} alt="" className="h-8 w-8" />
            <h1 className="text-2xl font-semibold text-[color:var(--tool-strong)]">FrameOS flasher</h1>
          </div>
          <p className={mutedClass}>
            Put FrameOS on an ESP32 frame from this browser, over a USB cable. No account: a frame of its own, or one
            your own FrameOS backend set up. Guide:{' '}
            <a className="underline" href="https://frameos.net/guide/flasher" target="_blank" rel="noreferrer">
              frameos.net/guide/flasher
            </a>
            .
          </p>
        </header>
        {!usbSupported ? (
          <Card>
            <div className="text-sm font-semibold text-red-500">
              {usbBlockedHere
                ? 'This page cannot use USB here. Open it in a tab of its own.'
                : 'This browser cannot talk to USB devices. Open this page in Chrome or Edge on a computer.'}
            </div>
          </Card>
        ) : null}
        {mode === 'bridge' && waitingForBridge ? (
          <Card>
            <div className="flex items-center gap-2 text-sm">
              <Spinner /> Waiting for the FrameOS page that opened this window…
            </div>
          </Card>
        ) : null}
        {problem && mode === 'bridge' ? (
          <Card>
            <div className="text-sm font-semibold text-red-500">{problem}</div>
          </Card>
        ) : null}
        {job ? <JobCard /> : mode === 'bridge' ? null : <StandaloneCard />}
        {!job && mode !== 'bridge' ? <SetupFileCard /> : null}
        <BoardToolsCard />
        <footer className="frame-tool-muted pb-8 text-xs leading-5">
          Every image this page writes is a FrameOS release, checked against the release signing key in this browser
          first. Your settings and Wi-Fi go from this page to the board over the cable. Besides the page and its sample
          scenes it fetches only that firmware: from FrameOS, or from your backend when your backend opened it.{' '}
          <a className="underline" href="https://github.com/FrameOS/frameos">
            Source
          </a>
        </footer>
      </main>
    </div>
  )
}
