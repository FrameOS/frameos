import {
  MakeLogicType,
  actions,
  afterMount,
  beforeUnmount,
  connect,
  kea,
  listeners,
  path,
  reducers,
  selectors,
} from 'kea'

import {
  embeddedUsbLogsModel,
  startEmbeddedUsbLogStream,
  stopEmbeddedUsbLogStream,
  usbProvisionWifi,
  usbRestart,
  type EmbeddedUsbLogStreamState,
} from '../../../frontend/src/models/embeddedUsbLogsModel'
import type { FlashPhase } from '../../../frontend/src/scenes/workspace/embeddedFlashShared'
import {
  flashAndSetUpBoard,
  provisionOverUsb,
  skippedSettingsNotice,
  takeFlashPort,
  updateBoardKeepingSettings,
  type FlashReporter,
  type ProvisioningCommands,
} from '../../../frontend/src/scenes/workspace/embeddedFlashRun'
import {
  genericReleasePlatform,
  httpFirmwareSource,
  type FirmwareSource,
} from '../../../frontend/src/scenes/workspace/releaseFirmware'
import type { LogType } from '../../../frontend/src/types'
import { FrameSetupError, parseFrameSetupDocument, type FlasherJob } from '../../../frontend/src/utils/flasherBridge'
import { webSerialNeedsFlasher, webSerialSupported } from '../../../frontend/src/utils/webSerial'
import { browserTimeZone } from '../lib/browser-time-zone'
import { bridgeFirmwareSource, listenForBridgeJob, type BridgeConnection } from './bridgeClient'
import {
  CUSTOM_BOARD,
  boardFromQuery,
  standaloneBoard,
  standaloneProblem,
  standaloneProvisioning,
  starterSceneSet,
  type StandaloneChoices,
  type StarterTemplate,
} from './standalone'

// flash.frameos.net (cloud/docs/flasher.md). Three ways in, one page:
//   standalone  a board for nobody's plane, set up from what is picked here;
//   bridge      a job from the page that opened this window (a backend on
//               plain http, utils/flasherBridge.ts), reported back to it;
//   file        a job from a setup file dropped here.
// The flashing itself is the shared engine (embeddedFlashRun.ts), the same
// code the backend's own buttons run; this logic decides what goes in.

/** What this page's USB session and log lines are filed under. */
export const FLASHER_FRAME_ID = 'flasher'

/** The page's own release pipe (the cloud's, same origin), signed or nothing. */
export function publicFirmwareSource(): FirmwareSource {
  return httpFirmwareSource((url, init) => fetch(url, init), { requireSignature: true })
}

const STARTER_SCENES_URL = '/frames-app/flasher-scenes.json'

export type FlasherMode = 'standalone' | 'bridge' | 'file'

export interface FlasherRunResult {
  kind: 'setup' | 'update' | 'provision'
  ok: boolean
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface FlasherCache {
  stopListening?: () => void
  connection?: BridgeConnection | null
}

// This package runs no kea-typegen (frontend/ does), so the logic type is
// written by hand, as sceneLogic.tsx's is.
export interface flasherLogicValues {
  usbLogsByFrameId: Record<string, LogType[]>
  usbLogStreamStatesByFrameId: Record<string, EmbeddedUsbLogStreamState>
  mode: FlasherMode
  job: FlasherJob | null
  jobFrom: string | null
  waitingForBridge: boolean
  problem: string | null
  board: string
  panel: string
  pins: string
  name: string
  ssid: string
  password: string
  timeZone: string | null
  templates: StarterTemplate[] | null
  templatesError: string | null
  picked: string[]
  phase: FlashPhase
  message: string | null
  progress: number | null
  lastRun: FlasherRunResult | null
  toolSsid: string
  toolPassword: string
  toolBusy: boolean
  toolMessage: string | null
  busy: boolean
  usbSupported: boolean
  usbBlockedHere: boolean
  choices: StandaloneChoices
  standaloneIssue: string | null
  usbLogs: LogType[]
  boardConnected: boolean
}

export interface flasherLogicActions {
  appendUsbLog: (log: LogType) => { log: LogType }
  setMode: (mode: FlasherMode) => { mode: FlasherMode }
  setJob: (job: FlasherJob | null, from: string | null) => { job: FlasherJob | null; from: string | null }
  setWaitingForBridge: (waiting: boolean) => { waiting: boolean }
  setProblem: (problem: string | null) => { problem: string | null }
  openSetupFile: (file: File) => { file: File }
  setBoard: (board: string) => { board: string }
  setPanel: (panel: string) => { panel: string }
  setPins: (pins: string) => { pins: string }
  setName: (name: string) => { name: string }
  setSsid: (ssid: string) => { ssid: string }
  setPassword: (password: string) => { password: string }
  setTimeZone: (timeZone: string | null) => { timeZone: string | null }
  loadTemplates: () => { value: true }
  setTemplates: (
    templates: StarterTemplate[] | null,
    error: string | null
  ) => {
    templates: StarterTemplate[] | null
    error: string | null
  }
  togglePicked: (name: string) => { name: string }
  setPhase: (phase: FlashPhase) => { phase: FlashPhase }
  setMessage: (message: string | null) => { message: string | null }
  setProgress: (progress: number | null) => { progress: number | null }
  runSetup: () => { value: true }
  runUpdate: () => { value: true }
  runProvision: () => { value: true }
  setLastRun: (result: FlasherRunResult | null) => { result: FlasherRunResult | null }
  connectBoard: () => { value: true }
  disconnectBoard: () => { value: true }
  setToolSsid: (ssid: string) => { ssid: string }
  setToolPassword: (password: string) => { password: string }
  applyToolWifi: () => { value: true }
  restartBoard: () => { value: true }
  setToolBusy: (busy: boolean) => { busy: boolean }
  setToolMessage: (message: string | null) => { message: string | null }
}

export type flasherLogicType = MakeLogicType<flasherLogicValues, flasherLogicActions>

export const flasherLogic = kea<flasherLogicType>([
  path(['cloud', 'frontend', 'flasher', 'flasherLogic']),
  connect(() => ({
    values: [embeddedUsbLogsModel, ['usbLogsByFrameId', 'usbLogStreamStatesByFrameId']],
    actions: [embeddedUsbLogsModel, ['appendUsbLog']],
  })),
  actions({
    setMode: (mode: FlasherMode) => ({ mode }),
    setJob: (job: FlasherJob | null, from: string | null) => ({ job, from }),
    setWaitingForBridge: (waiting: boolean) => ({ waiting }),
    setProblem: (problem: string | null) => ({ problem }),
    openSetupFile: (file: File) => ({ file }),
    setBoard: (board: string) => ({ board }),
    setPanel: (panel: string) => ({ panel }),
    setPins: (pins: string) => ({ pins }),
    setName: (name: string) => ({ name }),
    setSsid: (ssid: string) => ({ ssid }),
    setPassword: (password: string) => ({ password }),
    setTimeZone: (timeZone: string | null) => ({ timeZone }),
    loadTemplates: true,
    setTemplates: (templates: StarterTemplate[] | null, error: string | null) => ({ templates, error }),
    togglePicked: (name: string) => ({ name }),
    setPhase: (phase: FlashPhase) => ({ phase }),
    setMessage: (message: string | null) => ({ message }),
    setProgress: (progress: number | null) => ({ progress }),
    runSetup: true,
    runUpdate: true,
    runProvision: true,
    setLastRun: (result: FlasherRunResult | null) => ({ result }),
    connectBoard: true,
    disconnectBoard: true,
    setToolSsid: (ssid: string) => ({ ssid }),
    setToolPassword: (password: string) => ({ password }),
    applyToolWifi: true,
    restartBoard: true,
    setToolBusy: (busy: boolean) => ({ busy }),
    setToolMessage: (message: string | null) => ({ message }),
  }),
  reducers({
    mode: ['standalone' as FlasherMode, { setMode: (_, { mode }) => mode }],
    job: [null as FlasherJob | null, { setJob: (_, { job }) => job }],
    jobFrom: [null as string | null, { setJob: (_, { from }) => from }],
    waitingForBridge: [false, { setWaitingForBridge: (_, { waiting }) => waiting, setJob: () => false }],
    problem: [null as string | null, { setProblem: (_, { problem }) => problem, setJob: () => null }],
    board: ['', { setBoard: (_, { board }) => board }],
    panel: ['', { setPanel: (_, { panel }) => panel, setBoard: () => '' }],
    pins: ['', { setPins: (_, { pins }) => pins }],
    name: ['FrameOS', { setName: (_, { name }) => name }],
    ssid: ['', { setSsid: (_, { ssid }) => ssid }],
    password: ['', { setPassword: (_, { password }) => password }],
    timeZone: [null as string | null, { setTimeZone: (_, { timeZone }) => timeZone }],
    templates: [null as StarterTemplate[] | null, { setTemplates: (_, { templates }) => templates }],
    templatesError: [null as string | null, { setTemplates: (_, { error }) => error }],
    picked: [
      [] as string[],
      {
        setTemplates: (_, { templates }) =>
          (templates ?? []).filter((template) => template.preselected).map((template) => template.name),
        togglePicked: (state, { name }) =>
          state.includes(name) ? state.filter((picked) => picked !== name) : [...state, name],
      },
    ],
    phase: ['idle' as FlashPhase, { setPhase: (_, { phase }) => phase, setJob: () => 'idle' }],
    message: [null as string | null, { setMessage: (_, { message }) => message, setJob: () => null }],
    progress: [null as number | null, { setProgress: (_, { progress }) => progress }],
    lastRun: [null as FlasherRunResult | null, { setLastRun: (_, { result }) => result, setJob: () => null }],
    toolSsid: ['', { setToolSsid: (_, { ssid }) => ssid }],
    toolPassword: ['', { setToolPassword: (_, { password }) => password, applyToolWifi: () => '' }],
    toolBusy: [false, { setToolBusy: (_, { busy }) => busy }],
    toolMessage: [null as string | null, { setToolMessage: (_, { message }) => message }],
  }),
  selectors({
    busy: [
      (s) => [s.phase, s.toolBusy],
      (phase: FlashPhase, toolBusy: boolean): boolean =>
        toolBusy || phase === 'connecting' || phase === 'preparing' || phase === 'flashing',
    ],
    usbSupported: [() => [], (): boolean => webSerialSupported()],
    usbBlockedHere: [() => [], (): boolean => webSerialNeedsFlasher()],
    choices: [
      (s) => [s.board, s.panel, s.pins, s.name, s.ssid, s.password, s.timeZone],
      (board, panel, pins, name, ssid, password, timeZone): StandaloneChoices => ({
        board,
        panel: panel || standaloneBoard(board)?.defaultPanel || '',
        pins,
        name,
        timeZone,
        wifi: ssid.trim() ? { ssid: ssid.trim(), password } : null,
      }),
    ],
    standaloneIssue: [(s) => [s.choices], (choices: StandaloneChoices): string | null => standaloneProblem(choices)],
    usbLogs: [
      (s) => [s.usbLogsByFrameId],
      (logs: Record<string, LogType[]>): LogType[] => logs[FLASHER_FRAME_ID] ?? [],
    ],
    boardConnected: [
      (s) => [s.usbLogStreamStatesByFrameId],
      (states: Record<string, EmbeddedUsbLogStreamState>): boolean => states[FLASHER_FRAME_ID]?.status === 'streaming',
    ],
  }),
  listeners(({ actions, values, cache }) => {
    const state = cache as FlasherCache

    // Every status change also goes to the page that sent the job.
    const reporter = (): FlashReporter => ({
      frameId: FLASHER_FRAME_ID,
      setPhase: (phase) => {
        actions.setPhase(phase)
        state.connection?.status(phase, values.message, values.progress)
      },
      setProgress: (progress) => {
        actions.setProgress(progress)
        state.connection?.status(values.phase, values.message, progress)
      },
      setMessage: (message) => {
        actions.setMessage(message)
        state.connection?.status(values.phase, message, values.progress)
      },
    })

    const firmware = (): FirmwareSource =>
      values.mode === 'bridge' && state.connection ? bridgeFirmwareSource(state.connection) : publicFirmwareSource()

    // What happens after any run that left the board on a port: its log
    // stream, so the tools below work and (on a bridge) the opener's Logs
    // panel keeps getting the board's lines.
    const keepListening = async (port: SerialPort): Promise<void> => {
      await startEmbeddedUsbLogStream(FLASHER_FRAME_ID, port)
    }

    const finish = (kind: FlasherRunResult['kind'], outcome: 'done' | 'written' | 'failed' | 'cancelled'): void => {
      if (outcome !== 'cancelled') {
        actions.setLastRun({ kind, ok: outcome === 'done' })
      }
      state.connection?.send({ type: 'finished', outcome, message: values.message })
    }

    return {
      appendUsbLog: ({ log }) => {
        if (state.connection && String(log.frame_id) === FLASHER_FRAME_ID) {
          state.connection.send({ type: 'log', line: log.line })
        }
      },
      openSetupFile: async ({ file }) => {
        actions.setProblem(null)
        try {
          if (file.size > 16 * 1024 * 1024) {
            throw new FrameSetupError('This file is too big to be a FrameOS setup file.')
          }
          const setup = parseFrameSetupDocument(JSON.parse(await file.text()))
          actions.setMode('file')
          // A file may meet a board that is blank or one that already runs
          // FrameOS: both buttons, and either sends the frame's Wi-Fi.
          actions.setJob({ kind: 'setup', setup, withWifi: true }, file.name)
        } catch (error) {
          actions.setProblem(
            error instanceof SyntaxError ? 'This is not a FrameOS setup file (it is not JSON).' : errorDetail(error)
          )
        }
      },
      loadTemplates: async () => {
        try {
          const response = await fetch(STARTER_SCENES_URL)
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
          }
          actions.setTemplates((await response.json()) as StarterTemplate[], null)
        } catch (error) {
          actions.setTemplates(null, `Could not load the starter scenes (${errorDetail(error)}).`)
        }
      },
      runSetup: async () => {
        // In the click: the port prompt is the engine's first await.
        const job = values.job
        let plan: ProvisioningCommands
        let scenes: () => Promise<unknown[]>
        let chipPlatform = 'esp32-s3-generic'
        let configuredPlatform = 'esp32-s3-generic'
        let configuredFlashSize: string | null = null
        if (job) {
          plan = job.setup.provisioning
          scenes = async () => job.setup.scenes
          chipPlatform = genericReleasePlatform(job.setup.provisioning.platform)
          configuredPlatform = job.setup.provisioning.releasePlatform || chipPlatform
          configuredFlashSize = job.setup.provisioning.releaseFlashSize
        } else {
          if (values.standaloneIssue) {
            actions.setMessage(values.standaloneIssue)
            actions.setPhase('error')
            return
          }
          plan = standaloneProvisioning(values.choices)
          const picked = new Set(values.picked)
          const templates = values.templates ?? []
          scenes = async () => starterSceneSet(templates, picked)
        }
        const connection = state.connection
        const outcome = await flashAndSetUpBoard(reporter(), {
          firmware: firmware(),
          chipPlatform,
          configuredPlatform,
          configuredFlashSize,
          plan,
          scenes,
          onFlashSizeDetected:
            connection && values.mode === 'bridge'
              ? async (flashSize) => connection.send({ type: 'flash-size', flashSize })
              : undefined,
          onScenesUploaded:
            connection && values.mode === 'bridge'
              ? async () => connection.send({ type: 'scenes-uploaded' })
              : undefined,
        })
        if (outcome.status === 'done') {
          const notice = skippedSettingsNotice(outcome.skipped)
          if (notice) {
            actions.setToolMessage(notice)
          }
        }
        finish('setup', outcome.status)
        if (outcome.status === 'done' || outcome.status === 'written') {
          await keepListening(outcome.port)
        }
      },
      runUpdate: async () => {
        const job = values.job
        const outcome = await updateBoardKeepingSettings(reporter(), {
          firmware: firmware(),
          knownChip: job?.setup.provisioning.platform.startsWith('esp32-')
            ? job.setup.provisioning.platform
            : undefined,
          fallbackPlatform: async () =>
            job?.setup.provisioning.releasePlatform ||
            genericReleasePlatform(job?.setup.provisioning.platform ?? 'esp32-s3'),
          scenes: job?.pushScenes ? job.setup.scenes : null,
        })
        finish('update', outcome.status)
        if (outcome.status === 'done' || outcome.status === 'written') {
          await keepListening(outcome.port)
        }
      },
      runProvision: async () => {
        const job = values.job
        if (!job) {
          return
        }
        const report = reporter()
        report.setPhase('connecting')
        report.setMessage('Selecting USB port')
        let port: SerialPort | null = null
        try {
          port = await takeFlashPort(FLASHER_FRAME_ID)
          if (!port) {
            report.setPhase('idle')
            report.setMessage(null)
            finish('provision', 'cancelled')
            return
          }
          report.setPhase('preparing')
          const plan = job.setup.provisioning
          const { skipped } = await provisionOverUsb(FLASHER_FRAME_ID, plan, port, report.setMessage)
          const sent = plan.settings.length - skipped.length
          const wifi = job.withWifi ? plan.wifi : null
          if (wifi) {
            report.setMessage(`Sent ${sent} settings to the board; joining ${wifi.ssid} and restarting it.`)
            await usbProvisionWifi(FLASHER_FRAME_ID, wifi.ssid, wifi.password, { port, keepOpen: true })
          } else {
            report.setMessage(`Sent ${sent} settings to the board; restarting it to apply them.`)
            await usbRestart(FLASHER_FRAME_ID, { port, keepOpen: true })
          }
          const notice = skippedSettingsNotice(skipped)
          report.setPhase('done')
          report.setMessage(
            `Sent ${sent} settings to the board. It rebooted and is ${wifi ? `joining ${wifi.ssid}` : 'applying them'}.${
              notice ? ` ${notice}` : ''
            }`
          )
          finish('provision', 'done')
        } catch (error) {
          const detail = errorDetail(error)
          if (/No port selected|NotFoundError/i.test(detail)) {
            report.setPhase('idle')
            report.setMessage(null)
            finish('provision', 'cancelled')
            return
          }
          report.setPhase('error')
          report.setMessage(`Applying the frame's settings failed: ${detail}`)
          finish('provision', 'failed')
        }
      },
      connectBoard: async () => {
        actions.setToolMessage(null)
        await startEmbeddedUsbLogStream(FLASHER_FRAME_ID)
      },
      disconnectBoard: async () => {
        await stopEmbeddedUsbLogStream(FLASHER_FRAME_ID)
      },
      applyToolWifi: async () => {
        const ssid = values.toolSsid.trim()
        if (!ssid) {
          actions.setToolMessage('Enter the Wi-Fi network’s name first.')
          return
        }
        actions.setToolBusy(true)
        actions.setToolMessage(null)
        try {
          // The password field empties on this action; the value went with it.
          await usbProvisionWifi(FLASHER_FRAME_ID, ssid, values.toolPassword || '', { promptIfNeeded: true })
          actions.setToolMessage(`Wi-Fi saved. The board restarted and is joining “${ssid}”.`)
        } catch (error) {
          actions.setToolMessage(`Could not set the Wi-Fi: ${errorDetail(error)}`)
        } finally {
          actions.setToolBusy(false)
        }
      },
      restartBoard: async () => {
        actions.setToolBusy(true)
        actions.setToolMessage(null)
        try {
          await usbRestart(FLASHER_FRAME_ID, { promptIfNeeded: true })
          actions.setToolMessage('The board is restarting.')
        } catch (error) {
          actions.setToolMessage(`Could not restart the board: ${errorDetail(error)}`)
        } finally {
          actions.setToolBusy(false)
        }
      },
    }
  }),
  afterMount(({ actions, cache }) => {
    const state = cache as FlasherCache
    actions.setTimeZone(browserTimeZone() ?? null)
    const board = boardFromQuery(window.location.search)
    if (board) {
      actions.setBoard(board)
    }
    actions.loadTemplates()
    if (new URLSearchParams(window.location.search).get('bridge') === '1') {
      actions.setMode('bridge')
      actions.setWaitingForBridge(true)
      state.stopListening = listenForBridgeJob(
        (connection) => {
          state.connection = connection
          actions.setJob(connection.job, connection.origin)
        },
        (problem) => {
          actions.setWaitingForBridge(false)
          actions.setProblem(problem)
        }
      )
    }
  }),
  beforeUnmount(({ cache }) => {
    const state = cache as FlasherCache
    state.stopListening?.()
  }),
])

export { CUSTOM_BOARD }
