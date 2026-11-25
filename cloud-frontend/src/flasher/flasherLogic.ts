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
import { sendFlasherEvent, type FlasherEventProperties } from './flasherEvents'
import { type FlasherSample } from './sampleCatalog'
import {
  FLASHER_SAMPLES_URL,
  flasherSampleGroups,
  storeCoversFromListing,
  withGroupPicked,
  type FlasherSampleGroup,
  type StoreCover,
} from './sampleList'
import {
  CUSTOM_BOARD,
  boardFromQuery,
  defaultScenePreset,
  pickedScenes,
  pickedScenesProblem,
  presetPicks,
  sceneUploadSeconds,
  standaloneBoard,
  standaloneBoardKind,
  standaloneProblem,
  standaloneProvisioning,
  standaloneSceneRoom,
  starterSceneSet,
  type PickedScenes,
  type ScenePresetKey,
  type StandaloneBoardKind,
  type StandaloneChoices,
  type StandaloneSceneRoom,
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

/** The store's public listing, which the flasher's host serves (surfaces.ts). */
const STORE_LISTING_PATH = '/api/store/repository.json'

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
  /** Each picked sample's scenes, fetched once. */
  sampleScenes?: Map<string, Promise<Record<string, unknown>[]>>
  /** The run being counted (flasherEvents.ts): when it started and what it was. */
  run?: { startedAt: number; properties: FlasherEventProperties }
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
  samples: FlasherSample[] | null
  samplesError: string | null
  storeCovers: Record<string, StoreCover>
  picked: string[]
  preset: ScenePresetKey | null
  noRoom: string[]
  query: string
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
  boardKind: StandaloneBoardKind
  sceneRoom: StandaloneSceneRoom
  chosenScenes: PickedScenes
  scenesIssue: string | null
  uploadSeconds: number
  sampleGroups: FlasherSampleGroup[]
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
  loadSamples: () => { value: true }
  loadStoreCovers: () => { value: true }
  setStoreCovers: (covers: Record<string, StoreCover>) => { covers: Record<string, StoreCover> }
  setSamples: (
    samples: FlasherSample[] | null,
    error: string | null
  ) => {
    samples: FlasherSample[] | null
    error: string | null
  }
  togglePicked: (name: string) => { name: string }
  setGroupPicked: (names: string[], picked: boolean) => { names: string[]; picked: boolean }
  applyPreset: (preset: ScenePresetKey) => { preset: ScenePresetKey }
  setPicks: (
    picked: string[],
    preset: ScenePresetKey | null,
    noRoom: string[]
  ) => { picked: string[]; preset: ScenePresetKey | null; noRoom: string[] }
  setQuery: (query: string) => { query: string }
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
    loadSamples: true,
    loadStoreCovers: true,
    setStoreCovers: (covers: Record<string, StoreCover>) => ({ covers }),
    setSamples: (samples: FlasherSample[] | null, error: string | null) => ({ samples, error }),
    togglePicked: (name: string) => ({ name }),
    setGroupPicked: (names: string[], picked: boolean) => ({ names, picked }),
    applyPreset: (preset: ScenePresetKey) => ({ preset }),
    setPicks: (picked: string[], preset: ScenePresetKey | null, noRoom: string[]) => ({ picked, preset, noRoom }),
    setQuery: (query: string) => ({ query }),
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
    samples: [null as FlasherSample[] | null, { setSamples: (_, { samples }) => samples }],
    samplesError: [null as string | null, { setSamples: (_, { error }) => error }],
    storeCovers: [{} as Record<string, StoreCover>, { setStoreCovers: (_, { covers }) => covers }],
    picked: [
      [] as string[],
      {
        setPicks: (_, { picked }) => picked,
        togglePicked: (state, { name }) =>
          state.includes(name) ? state.filter((picked) => picked !== name) : [...state, name],
        setGroupPicked: (state, { names, picked }) => withGroupPicked(state, names, picked),
      },
    ],
    // The preset the picks came from; null once a sample is ticked by hand.
    preset: [
      defaultScenePreset() as ScenePresetKey | null,
      { setPicks: (_, { preset }) => preset, togglePicked: () => null, setGroupPicked: () => null },
    ],
    noRoom: [
      [] as string[],
      { setPicks: (_, { noRoom }) => noRoom, togglePicked: () => [], setGroupPicked: () => [] },
    ],
    query: ['', { setQuery: (_, { query }) => query }],
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
    boardKind: [(s) => [s.board], (board: string): StandaloneBoardKind => standaloneBoardKind(board)],
    sceneRoom: [(s) => [s.boardKind], (kind: StandaloneBoardKind): StandaloneSceneRoom => standaloneSceneRoom(kind)],
    chosenScenes: [
      (s) => [s.samples, s.picked],
      (samples: FlasherSample[] | null, picked: string[]): PickedScenes => pickedScenes(samples ?? [], picked),
    ],
    scenesIssue: [
      (s) => [s.chosenScenes, s.boardKind, s.samples],
      (chosen: PickedScenes, kind: StandaloneBoardKind, samples: FlasherSample[] | null): string | null =>
        pickedScenesProblem(chosen, kind, samples),
    ],
    uploadSeconds: [
      (s) => [s.chosenScenes, s.sceneRoom],
      (chosen: PickedScenes, room: StandaloneSceneRoom): number =>
        sceneUploadSeconds(chosen.bytes, chosen.scenes, room.flashSize),
    ],
    sampleGroups: [
      (s) => [s.samples, s.picked, s.storeCovers, s.query],
      (samples: FlasherSample[] | null, picked: string[], covers: Record<string, StoreCover>, query: string) =>
        flasherSampleGroups(samples, picked, covers, query),
    ],
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

    // A picked sample's scenes, fetched once (build.mjs writes one file each).
    const sampleScenes = (sample: FlasherSample): Promise<Record<string, unknown>[]> => {
      state.sampleScenes ??= new Map()
      let scenes = state.sampleScenes.get(sample.file)
      if (!scenes) {
        scenes = fetch(`${FLASHER_SAMPLES_URL}${encodeURIComponent(sample.file)}`).then(async (response) => {
          if (!response.ok) {
            throw new Error(`Could not fetch the scenes of ${sample.title} (HTTP ${response.status}).`)
          }
          const json: unknown = await response.json()
          if (!Array.isArray(json)) {
            throw new Error(`The scenes of ${sample.title} are not a list.`)
          }
          return json as Record<string, unknown>[]
        })
        scenes.catch(() => state.sampleScenes?.delete(sample.file))
        state.sampleScenes.set(sample.file, scenes)
      }
      return scenes
    }

    // What a run is counted with: the board and how many scenes, never a
    // name, a network or an address.
    const runFacts = (kind: FlasherRunResult['kind']): FlasherEventProperties => {
      const job = values.job
      if (job) {
        const settings = job.setup.provisioning.settings
        return {
          kind,
          mode: values.mode,
          board: settings.find((setting) => setting.key === 'hardware')?.value,
          panel: settings.find((setting) => setting.key === 'panel')?.value,
          platform: job.setup.provisioning.platform,
          scenes: job.setup.scenes.length,
        }
      }
      if (kind !== 'setup') {
        return { kind, mode: values.mode }
      }
      const panelPicked = values.board === CUSTOM_BOARD || standaloneBoard(values.board)?.panelSelectable
      return {
        kind,
        mode: values.mode,
        board: values.board || undefined,
        panel: panelPicked ? values.choices.panel || undefined : undefined,
        preset: values.preset ?? 'hand',
        scenes: values.chosenScenes.scenes,
        scene_bytes: values.chosenScenes.bytes,
      }
    }

    const started = (kind: FlasherRunResult['kind']): void => {
      const properties = runFacts(kind)
      state.run = { startedAt: Date.now(), properties }
      sendFlasherEvent('flasher flash started', properties)
    }

    const finish = (
      kind: FlasherRunResult['kind'],
      outcome: 'done' | 'written' | 'failed' | 'cancelled',
      found: FlasherEventProperties = {}
    ): void => {
      if (outcome !== 'cancelled') {
        actions.setLastRun({ kind, ok: outcome === 'done' })
      }
      state.connection?.send({ type: 'finished', outcome, message: values.message })
      const run = state.run
      state.run = undefined
      sendFlasherEvent('flasher flash finished', {
        ...(run?.properties ?? { kind, mode: values.mode }),
        outcome,
        seconds: run ? (Date.now() - run.startedAt) / 1000 : undefined,
        ...found,
      })
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
      loadSamples: async () => {
        try {
          const response = await fetch(`${FLASHER_SAMPLES_URL}index.json`)
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
          }
          const index = (await response.json()) as { samples?: FlasherSample[] }
          actions.setSamples(Array.isArray(index.samples) ? index.samples : [], null)
        } catch (error) {
          actions.setSamples(null, `Could not load the scenes to start with (${errorDetail(error)}).`)
        }
      },
      loadStoreCovers: async () => {
        // Thumbnails only: without the listing the list is as it was.
        try {
          const response = await fetch(STORE_LISTING_PATH)
          if (response.ok) {
            actions.setStoreCovers(
              storeCoversFromListing(await response.json(), new URL(STORE_LISTING_PATH, window.location.origin).href)
            )
          }
        } catch {
          // No covers.
        }
      },
      setSamples: () => {
        actions.applyPreset(values.preset ?? defaultScenePreset())
      },
      setBoard: () => {
        // Picks a preset made follow the board (what fits its panel and its
        // room); picks made by hand stay.
        if (values.preset !== null && values.samples) {
          actions.applyPreset(values.preset)
        }
      },
      applyPreset: ({ preset }) => {
        const { picked, noRoom } = presetPicks(preset, values.samples ?? [], values.boardKind)
        actions.setPicks(picked, preset, noRoom)
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
          if (values.scenesIssue) {
            actions.setMessage(values.scenesIssue)
            actions.setPhase('error')
            return
          }
          plan = standaloneProvisioning(values.choices)
          const kind = values.boardKind
          // Fetched now, without waiting: the port prompt must stay the
          // click's first await. The engine asks for them after the flash.
          const fetched = Promise.all(values.chosenScenes.samples.map((sample) => sampleScenes(sample)))
          fetched.catch(() => undefined)
          scenes = async () => starterSceneSet(await fetched, kind)
        }
        started('setup')
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
        finish(
          'setup',
          outcome.status,
          outcome.status === 'done' ? { platform: outcome.platform, flash_size: outcome.detectedFlashSize } : {}
        )
        if (outcome.status === 'done' || outcome.status === 'written') {
          await keepListening(outcome.port)
        }
      },
      runUpdate: async () => {
        const job = values.job
        started('update')
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
        started('provision')
        const report = reporter()
        report.setPhase('connecting')
        report.setMessage('Choose the board’s port in the browser’s prompt.')
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
            report.setMessage(`Sent ${sent} settings. The board is restarting and joining ${wifi.ssid}.`)
            await usbProvisionWifi(FLASHER_FRAME_ID, wifi.ssid, wifi.password, { port, keepOpen: true })
          } else {
            report.setMessage(`Sent ${sent} settings. The board is restarting to use them.`)
            await usbRestart(FLASHER_FRAME_ID, { port, keepOpen: true })
          }
          const notice = skippedSettingsNotice(skipped)
          report.setPhase('done')
          report.setMessage(
            `Sent ${sent} settings. The board restarted${wifi ? ` and is joining ${wifi.ssid}` : ' with them'}.${
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
          report.setMessage(`Could not send the settings: ${detail}`)
          finish('provision', 'failed')
        }
      },
      connectBoard: async () => {
        actions.setToolMessage(null)
        sendFlasherEvent('flasher tool used', { tool: 'connect' })
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
          sendFlasherEvent('flasher tool used', { tool: 'wifi', outcome: 'done' })
        } catch (error) {
          actions.setToolMessage(`Could not set the Wi-Fi: ${errorDetail(error)}`)
          sendFlasherEvent('flasher tool used', { tool: 'wifi', outcome: 'failed' })
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
          sendFlasherEvent('flasher tool used', { tool: 'restart', outcome: 'done' })
        } catch (error) {
          actions.setToolMessage(`Could not restart the board: ${errorDetail(error)}`)
          sendFlasherEvent('flasher tool used', { tool: 'restart', outcome: 'failed' })
        } finally {
          actions.setToolBusy(false)
        }
      },
    }
  }),
  afterMount(({ actions, values, cache }) => {
    const state = cache as FlasherCache
    actions.setTimeZone(browserTimeZone() ?? null)
    const board = boardFromQuery(window.location.search)
    if (board) {
      actions.setBoard(board)
    }
    sendFlasherEvent('flasher opened', {
      entry: new URLSearchParams(window.location.search).get('bridge') === '1' ? 'bridge' : 'page',
      usb: values.usbSupported ? 'yes' : values.usbBlockedHere ? 'blocked' : 'no',
      board: board ?? undefined,
      board_from_link: Boolean(board),
    })
    actions.loadSamples()
    actions.loadStoreCovers()
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
