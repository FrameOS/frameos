import { actions, afterMount, connect, kea, listeners, path, reducers } from 'kea'
import { subscriptions } from 'kea-subscriptions'
import { framesModel } from '../../models/framesModel'
import { workspaceLogic } from './workspaceLogic'
import type { framesHomeLogicType } from './framesHomeLogicType'

export const framesHomeLogic = kea<framesHomeLogicType>([
  path(['src', 'scenes', 'workspace', 'framesHomeLogic']),
  connect(() => ({
    values: [framesModel, ['framesList']],
  })),
  actions({
    startFrameOrderSnapshot: true,
    snapshotFrameOrderIfNeeded: true,
    markFrameOrderSnapshotted: true,
  }),
  reducers({
    frameOrderSnapshotted: [
      false,
      {
        startFrameOrderSnapshot: () => false,
        markFrameOrderSnapshotted: () => true,
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    snapshotFrameOrderIfNeeded: () => {
      if (values.frameOrderSnapshotted || values.framesList.length === 0) {
        return
      }
      workspaceLogic.actions.snapshotFrameOrder()
      actions.markFrameOrderSnapshotted()
    },
  })),
  subscriptions(({ actions, values }) => ({
    framesList: () => {
      if (!values.frameOrderSnapshotted) {
        actions.snapshotFrameOrderIfNeeded()
      }
    },
  })),
  afterMount(({ actions }) => {
    actions.startFrameOrderSnapshot()
    actions.snapshotFrameOrderIfNeeded()
  }),
])
