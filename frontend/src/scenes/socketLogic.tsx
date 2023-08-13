import { actions, afterMount, beforeUnmount, kea, path } from 'kea'
import { connect } from 'socket.io-client'
import { FrameType, LogType } from '../types'

import type { socketLogicType } from './socketLogicType'

export const socketLogic = kea<socketLogicType>([
  path(['src', 'scenes', 'socketLogic']),
  actions({
    newLog: (log: LogType) => ({ log }),
    newFrame: (frame: FrameType) => ({ frame }),
    updateFrame: (frame: FrameType) => ({ frame }),
    deleteFrame: ({ id }: { id: number }) => ({ id }),
  }),
  afterMount(({ actions, cache }) => {
    cache.socket = connect('/')
    cache.socket.on('new_log', actions.newLog)
    cache.socket.on('new_frame', actions.newFrame)
    cache.socket.on('update_frame', actions.updateFrame)
    cache.socket.on('delete_frame', actions.deleteFrame)
  }),
  beforeUnmount(({ cache }) => {
    cache.socket.close()
  }),
])
