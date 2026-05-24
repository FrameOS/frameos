import { actions, connect, kea, listeners, path, reducers, selectors } from 'kea'
import type { LogType, FrameType } from '../types'
import { socketLogic } from '../scenes/socketLogic'
import type { longRunningTasksModelType } from './longRunningTasksModelType'

export type LongRunningTaskKind = 'deploy' | 'render' | 'preview' | 'activate' | 'upload' | 'agentDeploy'
export type LongRunningTaskStatus = 'running' | 'success' | 'error'

export interface LongRunningTaskLog {
  id: string
  timestamp: string
  type: string
  line: string
}

export interface LongRunningTask {
  id: string
  frameId: number
  kind: LongRunningTaskKind
  sceneId?: string | null
  title: string
  detail?: string | null
  status: LongRunningTaskStatus
  startedAt: string
  completedAt?: string | null
  expanded: boolean
  activeStatusSeen?: boolean
  progressCurrent?: number | null
  progressTotal?: number | null
  logs: LongRunningTaskLog[]
}

export interface StartTaskPayload {
  id?: string
  frameId: number
  kind: LongRunningTaskKind
  title: string
  detail?: string | null
  sceneId?: string | null
  progressCurrent?: number | null
  progressTotal?: number | null
}

export interface FinishTaskPayload {
  taskId?: string
  frameId: number
  kind?: LongRunningTaskKind
  sceneId?: string | null
  status?: LongRunningTaskStatus
  detail?: string | null
}

export interface UpdateTaskProgressPayload {
  taskId?: string
  frameId: number
  kind?: LongRunningTaskKind
  sceneId?: string | null
  progressCurrent: number
  progressTotal: number
  detail?: string | null
}

const MAX_TASK_LOGS = 200
const COMPLETED_TASK_DISMISS_MS = 4000
const ERRORED_TASK_DISMISS_MS = 12000
const RENDER_SIGNAL_TIMEOUT_MS = 45000
const DEPLOY_ACTIVE_STATUSES = new Set(['deploying', 'preparing', 'restarting', 'starting'])
const DEPLOY_FAILED_STATUSES = new Set(['uninitialized'])
const SOCKET_NEW_LOG = 'new log (src.scenes.socketLogic)'
const SOCKET_NEW_SCENE_IMAGE = 'new scene image (src.scenes.socketLogic)'
const SOCKET_FRAME_RENDERED = 'frame rendered (src.scenes.socketLogic)'
const SOCKET_UPDATE_FRAME = 'update frame (src.scenes.socketLogic)'

let nextTaskCounter = 0

function nextTaskId(frameId: number, kind: LongRunningTaskKind, sceneId?: string | null): string {
  nextTaskCounter += 1
  return [kind, frameId, sceneId || 'frame', Date.now(), nextTaskCounter].join(':')
}

function latestRunningTaskIndex(tasks: LongRunningTask[], payload: FinishTaskPayload): number {
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    const task = tasks[index]
    if (payload.taskId && task.id !== payload.taskId) {
      continue
    }
    if (task.status !== 'running' || task.frameId !== payload.frameId) {
      continue
    }
    if (payload.kind && task.kind !== payload.kind) {
      continue
    }
    if (payload.sceneId && task.sceneId && task.sceneId !== payload.sceneId) {
      continue
    }
    return index
  }
  return -1
}

function updateLatestTaskProgress(tasks: LongRunningTask[], payload: UpdateTaskProgressPayload): LongRunningTask[] {
  const index = latestRunningTaskIndex(tasks, payload)
  if (index === -1) {
    return tasks
  }

  const task = tasks[index]
  const nextTasks = [...tasks]
  nextTasks[index] = {
    ...task,
    detail: payload.detail ?? task.detail,
    progressCurrent: payload.progressCurrent,
    progressTotal: payload.progressTotal,
  }
  return nextTasks
}

function latestRunningTask(tasks: LongRunningTask[], payload: FinishTaskPayload): LongRunningTask | null {
  const index = latestRunningTaskIndex(tasks, payload)
  return index === -1 ? null : tasks[index]
}

function finishLatestTask(tasks: LongRunningTask[], payload: FinishTaskPayload): LongRunningTask[] {
  const index = latestRunningTaskIndex(tasks, payload)
  if (index === -1) {
    return tasks
  }

  const task = tasks[index]
  const nextTasks = [...tasks]
  nextTasks[index] = {
    ...task,
    status: payload.status ?? 'success',
    detail: payload.detail ?? task.detail,
    completedAt: new Date().toISOString(),
  }
  return nextTasks
}

function appendLog(tasks: LongRunningTask[], log: LogType): LongRunningTask[] {
  let changed = false
  const nextTasks = tasks.map((task) => {
    if (task.status !== 'running' || task.frameId !== log.frame_id) {
      return task
    }
    changed = true
    return {
      ...task,
      logs: [
        ...task.logs,
        {
          id: `${log.id}`,
          timestamp: log.timestamp,
          type: log.type,
          line: log.line,
        },
      ].slice(-MAX_TASK_LOGS),
    }
  })
  return changed ? nextTasks : tasks
}

function parseWebhookEvent(log: LogType): Record<string, any> | null {
  if (log.type !== 'webhook') {
    return null
  }
  try {
    return JSON.parse(log.line)
  } catch (error) {
    return null
  }
}

function frameStatus(frame: Partial<FrameType>): string | null {
  return typeof frame.status === 'string' ? frame.status : null
}

export const longRunningTasksModel = kea<longRunningTasksModelType>([
  connect(() => ({ logic: [socketLogic] })),
  path(['src', 'models', 'longRunningTasksModel']),
  actions({
    startTask: (task: StartTaskPayload) => ({
      task: {
        ...task,
        id: task.id ?? nextTaskId(task.frameId, task.kind, task.sceneId),
        status: 'running' as LongRunningTaskStatus,
        startedAt: new Date().toISOString(),
        expanded: false,
        activeStatusSeen: false,
        progressCurrent: task.progressCurrent ?? null,
        progressTotal: task.progressTotal ?? null,
        logs: [] as LongRunningTaskLog[],
      },
    }),
    finishTask: (task: FinishTaskPayload) => ({ task }),
    taskFailed: (task: FinishTaskPayload) => ({ task: { ...task, status: 'error' as LongRunningTaskStatus } }),
    updateTaskProgress: (task: UpdateTaskProgressPayload) => ({ task }),
    dismissTask: (taskId: string) => ({ taskId }),
    dismissCompletedTasks: (task: FinishTaskPayload) => ({ task }),
    toggleTaskExpanded: (taskId: string) => ({ taskId }),
    appendTaskLog: (log: LogType) => ({ log }),
  }),
  reducers({
    tasks: [
      [] as LongRunningTask[],
      {
        startTask: (state, { task }) => [...state, task],
        finishTask: (state, { task }) => finishLatestTask(state, task),
        taskFailed: (state, { task }) => finishLatestTask(state, task),
        updateTaskProgress: (state, { task }) => updateLatestTaskProgress(state, task),
        dismissTask: (state, { taskId }) => state.filter((task) => task.id !== taskId),
        dismissCompletedTasks: (state, { task }) =>
          state.filter((candidate) => {
            if (task.taskId && candidate.id !== task.taskId) {
              return true
            }
            if (candidate.status === 'running' || candidate.expanded || candidate.frameId !== task.frameId) {
              return true
            }
            if (task.kind && candidate.kind !== task.kind) {
              return true
            }
            if (task.sceneId && candidate.sceneId && candidate.sceneId !== task.sceneId) {
              return true
            }
            return false
          }),
        toggleTaskExpanded: (state, { taskId }) =>
          state.map((task) => (task.id === taskId ? { ...task, expanded: !task.expanded } : task)),
        appendTaskLog: (state, { log }) => appendLog(state, log),
        [SOCKET_NEW_LOG]: (state, { log }) => appendLog(state, log),
        [SOCKET_NEW_SCENE_IMAGE]: (state, { frameId, sceneId }) =>
          finishLatestTask(state, {
            frameId,
            kind: 'preview',
            sceneId,
            status: 'success',
            detail: 'Scene image updated',
          }),
        [SOCKET_FRAME_RENDERED]: (state, { frameId }) =>
          finishLatestTask(state, {
            frameId,
            kind: 'render',
            status: 'success',
            detail: 'Frame image updated',
          }),
        [SOCKET_UPDATE_FRAME]: (state, { frame }) => {
          const status = frameStatus(frame)
          if (!status || !DEPLOY_ACTIVE_STATUSES.has(status)) {
            return state
          }
          return state.map((task) =>
            task.status === 'running' && task.frameId === frame.id && task.kind === 'deploy'
              ? { ...task, activeStatusSeen: true }
              : task
          )
        },
      },
    ],
  }),
  selectors({
    visibleTasks: [(s) => [s.tasks], (tasks): LongRunningTask[] => tasks],
    runningTasks: [(s) => [s.tasks], (tasks): LongRunningTask[] => tasks.filter((task) => task.status === 'running')],
  }),
  listeners(({ actions, values }) => ({
    startTask: ({ task }) => {
      if (task.kind === 'preview' || task.kind === 'render' || task.kind === 'activate') {
        window.setTimeout(() => {
          const stillRunning = values.tasks.some(
            (runningTask) => runningTask.id === task.id && runningTask.status === 'running'
          )
          if (stillRunning) {
            actions.taskFailed({
              frameId: task.frameId,
              kind: task.kind,
              sceneId: task.sceneId,
              detail: 'No render signal received',
            })
          }
        }, RENDER_SIGNAL_TIMEOUT_MS)
      }
    },
    finishTask: ({ task }) => {
      window.setTimeout(
        () => {
          actions.dismissCompletedTasks(task)
        },
        task.status === 'error' ? ERRORED_TASK_DISMISS_MS : COMPLETED_TASK_DISMISS_MS
      )
    },
    taskFailed: ({ task }) => {
      window.setTimeout(() => {
        actions.dismissCompletedTasks(task)
      }, ERRORED_TASK_DISMISS_MS)
    },
    [SOCKET_NEW_SCENE_IMAGE]: ({ frameId, sceneId }) => {
      actions.finishTask({
        frameId,
        kind: 'preview',
        sceneId,
        status: 'success',
        detail: 'Scene image updated',
      })
    },
    [SOCKET_FRAME_RENDERED]: ({ frameId }) => {
      actions.finishTask({
        frameId,
        kind: 'render',
        status: 'success',
        detail: 'Frame image updated',
      })
    },
    [SOCKET_NEW_LOG]: ({ log }) => {
      const payload = parseWebhookEvent(log)
      if (!payload) {
        return
      }

      if (payload.event === 'render:done') {
        actions.finishTask({
          frameId: log.frame_id,
          kind: 'render',
          status: 'success',
          detail: 'Render complete',
        })
        actions.finishTask({
          frameId: log.frame_id,
          kind: 'preview',
          sceneId: payload.sceneId,
          status: 'success',
          detail: 'Preview rendered',
        })
        actions.finishTask({
          frameId: log.frame_id,
          kind: 'activate',
          sceneId: payload.sceneId,
          status: 'success',
          detail: 'Scene rendered',
        })
      } else if (payload.event === 'render:sceneChange') {
        actions.finishTask({
          frameId: log.frame_id,
          kind: 'preview',
          sceneId: payload.sceneId,
          status: 'success',
          detail: 'Preview started',
        })
        actions.finishTask({
          frameId: log.frame_id,
          kind: 'activate',
          sceneId: payload.sceneId,
          status: 'success',
          detail: 'Scene activated',
        })
      } else if (payload.event === 'render:device') {
        actions.finishTask({
          frameId: log.frame_id,
          kind: 'render',
          status: 'success',
          detail: 'Render reached display',
        })
      } else if (payload.event === 'render:error' || payload.event === 'event:error') {
        actions.taskFailed({
          frameId: log.frame_id,
          kind: 'render',
          detail: payload.error || 'Render failed',
        })
        actions.taskFailed({
          frameId: log.frame_id,
          kind: 'preview',
          detail: payload.error || 'Preview failed',
        })
        actions.taskFailed({
          frameId: log.frame_id,
          kind: 'activate',
          detail: payload.error || 'Scene activation failed',
        })
      }
    },
    [SOCKET_UPDATE_FRAME]: ({ frame }) => {
      const status = frameStatus(frame)
      if (!status) {
        return
      }
      if (status === 'ready') {
        const deployTask = latestRunningTask(values.tasks, { frameId: frame.id, kind: 'deploy' })
        if (!deployTask?.activeStatusSeen) {
          return
        }
        actions.finishTask({
          frameId: frame.id,
          kind: 'deploy',
          status: 'success',
          detail: 'Frame is ready',
        })
        return
      }
      if (DEPLOY_FAILED_STATUSES.has(status)) {
        actions.taskFailed({
          frameId: frame.id,
          kind: 'deploy',
          detail: 'Deploy did not complete',
        })
        return
      }
      if (!DEPLOY_ACTIVE_STATUSES.has(status)) {
        return
      }
      actions.appendTaskLog({
        id: Date.now(),
        frame_id: frame.id,
        timestamp: new Date().toISOString(),
        type: 'status',
        line: `Frame status: ${status}`,
      } as LogType)
    },
  })),
])
