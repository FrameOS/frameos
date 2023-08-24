import { actions, kea, key, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'

import type { frameLogicType } from './frameLogicType'

export interface FrameLogicProps {
  id: number
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),
  actions({
    setTab: (tab: string) => ({ tab }),
  }),
  reducers({
    tab: ['list', { setTab: (_, { tab }) => tab }],
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frame: [(s) => [framesModel.selectors.frames, s.id], (frames, id) => frames[id] || null],
  })),
])
