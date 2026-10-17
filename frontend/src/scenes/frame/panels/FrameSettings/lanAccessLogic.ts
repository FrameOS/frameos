import { MakeLogicType, actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { FrameId, FrameType } from '../../../../types'
import { framesModel } from '../../../../models/framesModel'
import { apiFetch } from '../../../../utils/apiFetch'
import { isInFrameAdminMode } from '../../../../utils/frameAdmin'

/**
 * The frame's LAN access switch (docs: "LAN access").
 *
 * Not a frame form field. Turning it on needs a code the frame draws on its
 * own panel, so the change happens on the device first and the frame row only
 * mirrors the result. Turning it off goes straight through.
 *
 * The backend and the cloud serve the same two routes
 * (`/api/frames/{id}/lan_access[/challenge]`); the frame's own admin page
 * talks to the device's `/api/network/local-access` routes and is normalized
 * to the same results here.
 */

export const LAN_ACCESS_CODE_LENGTH = 6
const LAN_ACCESS_CODE_PATTERN = /^\d{6}$/

export type LanAccessChallengeResult = { status: 'shown'; expiresInSeconds: number | null } | { status: 'queued' }
export type LanAccessSetResult = { status: 'applied'; lanAccess: boolean } | { status: 'queued' }

export interface LanAccessErrorInfo {
  token: string | null
  message: string
}

export class LanAccessError extends Error {
  token: string | null
  status: number

  constructor(token: string | null, message: string, status: number) {
    super(message)
    this.name = 'LanAccessError'
    this.token = token
    this.status = status
  }
}

const LAN_ACCESS_ERROR_COPY: Record<string, string> = {
  invalid_code: 'That code does not match the one on the frame.',
  code_expired: 'The code expired. Show a new one.',
  too_many_attempts: 'Too many wrong codes. Show a new one.',
  rate_limited: 'Too many wrong codes in the last hour. Try again later.',
  code_required: 'Enter the code showing on your frame.',
  no_panel: 'This frame has no screen to show a code on. Choose LAN access when you set the frame up instead.',
  unsupported: "Update this frame's FrameOS first.",
  persist_failed: 'The frame could not save the change. Try again.',
  challenge_failed: 'The frame could not make a code. Try again.',
}

/** The planes' `detail` is written for people; the copy here covers a bare token. */
export function lanAccessErrorMessage(token: string | null, detail?: string | null, status?: number): string {
  const text = detail?.trim()
  if (text) {
    return text
  }
  const copy = token ? LAN_ACCESS_ERROR_COPY[token] : undefined
  if (copy) {
    return copy
  }
  if (status === 502 || status === 504) {
    return 'Could not reach the frame. Check that it is on and try again.'
  }
  return 'Something went wrong. Try again.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json()
    return isRecord(payload) ? payload : {}
  } catch {
    return {}
  }
}

async function lanAccessErrorFrom(response: Response): Promise<LanAccessError> {
  const payload = await readJson(response)
  // `{detail, error}` at the top level; FastAPI's HTTPException nests a dict
  // detail one level down, so accept that too.
  const body = isRecord(payload.detail) ? payload.detail : payload
  const token = typeof body.error === 'string' ? body.error : null
  const detail = typeof body.detail === 'string' ? body.detail : typeof body.message === 'string' ? body.message : null
  return new LanAccessError(token, lanAccessErrorMessage(token, detail, response.status), response.status)
}

export function lanAccessErrorInfo(error: unknown): LanAccessErrorInfo {
  if (error instanceof LanAccessError) {
    return { token: error.token, message: error.message }
  }
  return { token: null, message: 'Could not reach the frame. Try again.' }
}

function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Ask the frame to draw a code on its panel. */
export async function requestLanAccessChallenge(frameId: FrameId): Promise<LanAccessChallengeResult> {
  if (isInFrameAdminMode()) {
    const response = await postJson('/api/network/local-access/challenge', { scope: 'localNetwork' })
    if (!response.ok) {
      throw await lanAccessErrorFrom(response)
    }
    const payload = await readJson(response)
    const expires = payload.expiresInSeconds
    return { status: 'shown', expiresInSeconds: typeof expires === 'number' ? expires : null }
  }
  const response = await postJson(`/api/frames/${frameId}/lan_access/challenge`, {})
  if (!response.ok) {
    throw await lanAccessErrorFrom(response)
  }
  const payload = await readJson(response)
  if (payload.status === 'queued') {
    return { status: 'queued' }
  }
  const expires = payload.expires_in_seconds
  return { status: 'shown', expiresInSeconds: typeof expires === 'number' ? expires : null }
}

/** Turn LAN access on (with the code from the panel) or off (no code). */
export async function setLanAccess(frameId: FrameId, enabled: boolean, code?: string): Promise<LanAccessSetResult> {
  const body: Record<string, unknown> = { enabled, ...(enabled && code ? { code } : {}) }
  if (isInFrameAdminMode()) {
    const response = await postJson('/api/network/local-access', { ...body, scope: 'localNetwork' })
    if (!response.ok) {
      throw await lanAccessErrorFrom(response)
    }
    const payload = await readJson(response)
    const value = payload.allowLocalNetworkAccess
    return { status: 'applied', lanAccess: typeof value === 'boolean' ? value : enabled }
  }
  const response = await postJson(`/api/frames/${frameId}/lan_access`, body)
  if (!response.ok) {
    throw await lanAccessErrorFrom(response)
  }
  const payload = await readJson(response)
  if (payload.status === 'queued') {
    return { status: 'queued' }
  }
  const value = payload.lan_access
  return { status: 'applied', lanAccess: typeof value === 'boolean' ? value : enabled }
}

export function sanitizeLanAccessCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, LAN_ACCESS_CODE_LENGTH)
}

/** Confirm failures after which the typed code is useless. */
const CODE_CLEARING_ERRORS = new Set(['invalid_code', 'code_expired', 'too_many_attempts'])
/** Show-code failures a retry cannot fix. */
const FINAL_CHALLENGE_ERRORS = new Set(['no_panel', 'unsupported', 'rate_limited'])

/**
 * Where the turn-on dialog is. Derived, not stored: `start` (nothing asked
 * yet), `requesting` (asking the frame for a code), `shown` (the code is on
 * the panel), `queued` (the frame is asleep and shows it when it wakes),
 * `confirming`, `done`, and `applyQueued` (the frame checks the code when it
 * wakes).
 */
export type LanAccessPhase =
  | 'closed'
  | 'start'
  | 'requesting'
  | 'shown'
  | 'queued'
  | 'confirming'
  | 'done'
  | 'applyQueued'

export interface LanAccessLogicProps {
  frameId: FrameId
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface lanAccessLogicValues {
  frames: Record<FrameId, FrameType> // framesModel
  canConfirm: boolean
  canRequestCode: boolean
  challenge: 'queued' | 'shown' | null
  code: string
  disableError: string | null
  disabling: boolean
  error: LanAccessErrorInfo | null
  frame: FrameType | null
  lanAccess: boolean | null
  modalOpen: boolean
  outcome: 'applied' | 'queued' | null
  pendingNote: string | null
  phase: LanAccessPhase
  queuedValue: boolean | null
  request: 'confirming' | 'idle' | 'showingCode'
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface lanAccessLogicActions {
  loadFrame: (id: FrameId) => {
    id: FrameId
  } // framesModel
  setFrameLanAccess: (
    id: FrameId,
    lanAccess: boolean
  ) => {
    id: FrameId
    lanAccess: boolean
  } // framesModel
  closeModal: () => {
    value: true
  }
  confirmCode: () => {
    value: true
  }
  confirmCodeFailure: (error: LanAccessErrorInfo) => {
    error: LanAccessErrorInfo
  }
  confirmCodeRequest: () => {
    value: true
  }
  confirmCodeSuccess: (result: LanAccessSetResult) => {
    result: LanAccessSetResult
  }
  disable: () => {
    value: true
  }
  disableFailure: (message: string) => {
    message: string
  }
  disableRequest: () => {
    value: true
  }
  disableSuccess: (result: LanAccessSetResult) => {
    result: LanAccessSetResult
  }
  openModal: () => {
    value: true
  }
  setCode: (code: string) => {
    code: string
  }
  showCode: () => {
    value: true
  }
  showCodeFailure: (error: LanAccessErrorInfo) => {
    error: LanAccessErrorInfo
  }
  showCodeRequest: () => {
    value: true
  }
  showCodeSuccess: (result: LanAccessChallengeResult) => {
    result: LanAccessChallengeResult
  }
  switchChanged: (enabled: boolean) => {
    enabled: boolean
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface lanAccessLogicMeta {
  key: FrameId
  __keaTypeGenInternalSelectorTypes: {
    frame: (frames: Record<FrameId, FrameType>, frameId: FrameId) => FrameType | null
    lanAccess: (frame: FrameType | null) => boolean | null
    phase: (
      modalOpen: boolean,
      outcome: 'applied' | 'queued' | null,
      request: 'confirming' | 'idle' | 'showingCode',
      challenge: 'queued' | 'shown' | null
    ) => LanAccessPhase
    canConfirm: (
      code: string,
      request: 'confirming' | 'idle' | 'showingCode',
      challenge: 'queued' | 'shown' | null
    ) => boolean
    canRequestCode: (request: 'confirming' | 'idle' | 'showingCode', error: LanAccessErrorInfo | null) => boolean
    pendingNote: (queuedValue: boolean | null, lanAccess: boolean | null) => string | null
  }
}

export type lanAccessLogicType = MakeLogicType<lanAccessLogicValues, lanAccessLogicActions, LanAccessLogicProps> &
  lanAccessLogicMeta

export const lanAccessLogic = kea<lanAccessLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'FrameSettings', 'lanAccessLogic']),
  props({} as LanAccessLogicProps),
  key((props) => props.frameId),
  connect(() => ({
    values: [framesModel, ['frames']],
    actions: [framesModel, ['loadFrame', 'setFrameLanAccess']],
  })),
  actions({
    switchChanged: (enabled: boolean) => ({ enabled }),
    openModal: true,
    closeModal: true,
    showCode: true,
    showCodeRequest: true,
    showCodeSuccess: (result: LanAccessChallengeResult) => ({ result }),
    showCodeFailure: (error: LanAccessErrorInfo) => ({ error }),
    setCode: (code: string) => ({ code }),
    confirmCode: true,
    confirmCodeRequest: true,
    confirmCodeSuccess: (result: LanAccessSetResult) => ({ result }),
    confirmCodeFailure: (error: LanAccessErrorInfo) => ({ error }),
    disable: true,
    disableRequest: true,
    disableSuccess: (result: LanAccessSetResult) => ({ result }),
    disableFailure: (message: string) => ({ message }),
  }),
  reducers({
    modalOpen: [
      false,
      {
        openModal: () => true,
        closeModal: () => false,
      },
    ],
    challenge: [
      null as 'shown' | 'queued' | null,
      {
        openModal: () => null,
        closeModal: () => null,
        showCodeSuccess: (_, { result }) => result.status,
      },
    ],
    request: [
      'idle' as 'idle' | 'showingCode' | 'confirming',
      {
        showCodeRequest: () => 'showingCode',
        showCodeSuccess: () => 'idle',
        showCodeFailure: () => 'idle',
        confirmCodeRequest: () => 'confirming',
        confirmCodeSuccess: () => 'idle',
        confirmCodeFailure: () => 'idle',
      },
    ],
    outcome: [
      null as 'applied' | 'queued' | null,
      {
        openModal: () => null,
        closeModal: () => null,
        showCodeRequest: () => null,
        confirmCodeSuccess: (_, { result }) => result.status,
      },
    ],
    code: [
      '',
      {
        setCode: (_, { code }) => sanitizeLanAccessCode(code),
        openModal: () => '',
        closeModal: () => '',
        showCodeSuccess: () => '',
        confirmCodeFailure: (state, { error }) => (error.token && CODE_CLEARING_ERRORS.has(error.token) ? '' : state),
      },
    ],
    error: [
      null as LanAccessErrorInfo | null,
      {
        openModal: () => null,
        closeModal: () => null,
        showCodeRequest: () => null,
        confirmCodeRequest: () => null,
        showCodeFailure: (_, { error }) => error,
        confirmCodeFailure: (_, { error }) => error,
        // Typing again answers "does not match"; the other errors stay until
        // a new code is shown.
        setCode: (state) => (state?.token === 'invalid_code' || state?.token === 'code_required' ? null : state),
      },
    ],
    disabling: [
      false,
      {
        disableRequest: () => true,
        disableSuccess: () => false,
        disableFailure: () => false,
      },
    ],
    disableError: [
      null as string | null,
      {
        disableRequest: () => null,
        disableFailure: (_, { message }) => message,
        openModal: () => null,
      },
    ],
    // The value a sleeping frame was asked for, until it reports it.
    queuedValue: [
      null as boolean | null,
      {
        disableRequest: () => null,
        disableSuccess: (_, { result }) => (result.status === 'queued' ? false : null),
        confirmCodeSuccess: (_, { result }) => (result.status === 'queued' ? true : null),
      },
    ],
  }),
  selectors({
    frame: [
      (s, p) => [s.frames, p.frameId],
      (frames: lanAccessLogicValues['frames'], frameId: FrameId): FrameType | null => frames[frameId] ?? null,
    ],
    lanAccess: [
      (s) => [s.frame],
      (frame: lanAccessLogicValues['frame']): boolean | null =>
        typeof frame?.lan_access === 'boolean' ? frame.lan_access : null,
    ],
    phase: [
      (s) => [s.modalOpen, s.outcome, s.request, s.challenge],
      (
        modalOpen: lanAccessLogicValues['modalOpen'],
        outcome: lanAccessLogicValues['outcome'],
        request: lanAccessLogicValues['request'],
        challenge: lanAccessLogicValues['challenge']
      ): LanAccessPhase => {
        if (!modalOpen) {
          return 'closed'
        }
        if (outcome === 'applied') {
          return 'done'
        }
        if (outcome === 'queued') {
          return 'applyQueued'
        }
        if (request === 'showingCode') {
          return 'requesting'
        }
        if (request === 'confirming') {
          return 'confirming'
        }
        return challenge ?? 'start'
      },
    ],
    canConfirm: [
      (s) => [s.code, s.request, s.challenge],
      (
        code: lanAccessLogicValues['code'],
        request: lanAccessLogicValues['request'],
        challenge: lanAccessLogicValues['challenge']
      ): boolean => request === 'idle' && challenge !== null && LAN_ACCESS_CODE_PATTERN.test(code),
    ],
    canRequestCode: [
      (s) => [s.request, s.error],
      (request: lanAccessLogicValues['request'], error: lanAccessLogicValues['error']): boolean =>
        request === 'idle' && !(error?.token && FINAL_CHALLENGE_ERRORS.has(error.token)),
    ],
    pendingNote: [
      (s) => [s.queuedValue, s.lanAccess],
      (queuedValue: lanAccessLogicValues['queuedValue'], lanAccess: lanAccessLogicValues['lanAccess']): string | null =>
        queuedValue === null || queuedValue === lanAccess
          ? null
          : queuedValue
          ? 'The frame checks the code when it wakes up.'
          : 'The frame turns LAN access off when it wakes up.',
    ],
  }),
  listeners(({ actions, values, props }) => ({
    switchChanged: ({ enabled }) => {
      // An unknown value cannot be changed from here (the switch is
      // disabled, but its label still clicks).
      if (values.lanAccess === null || enabled === values.lanAccess) {
        return
      }
      if (enabled) {
        actions.openModal()
      } else {
        actions.disable()
      }
    },
    showCode: async () => {
      if (values.request !== 'idle') {
        return
      }
      actions.showCodeRequest()
      try {
        actions.showCodeSuccess(await requestLanAccessChallenge(props.frameId))
      } catch (error) {
        actions.showCodeFailure(lanAccessErrorInfo(error))
      }
    },
    confirmCode: async () => {
      if (!values.canConfirm) {
        return
      }
      actions.confirmCodeRequest()
      try {
        actions.confirmCodeSuccess(await setLanAccess(props.frameId, true, values.code))
      } catch (error) {
        actions.confirmCodeFailure(lanAccessErrorInfo(error))
      }
    },
    confirmCodeSuccess: ({ result }) => {
      if (result.status === 'applied') {
        actions.setFrameLanAccess(props.frameId, result.lanAccess)
        actions.loadFrame(props.frameId)
      }
    },
    disable: async () => {
      if (values.disabling) {
        return
      }
      actions.disableRequest()
      try {
        actions.disableSuccess(await setLanAccess(props.frameId, false))
      } catch (error) {
        actions.disableFailure(lanAccessErrorInfo(error).message)
      }
    },
    disableSuccess: ({ result }) => {
      if (result.status === 'applied') {
        actions.setFrameLanAccess(props.frameId, result.lanAccess)
        actions.loadFrame(props.frameId)
      }
    },
  })),
])
