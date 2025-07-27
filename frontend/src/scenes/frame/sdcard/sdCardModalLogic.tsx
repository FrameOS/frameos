import { actions, kea, reducers, path, props, key, listeners } from 'kea'

import type { sdCardModalLogicType } from './sdCardModalLogicType'
import { framesModel } from '../../../models/framesModel'

export interface SDCardModalLogicProps {
  frameId: number
}

export const sdCardModalLogic = kea<sdCardModalLogicType>([
  path(['src', 'scenes', 'frame', 'sdcard', 'sdCardModalLogic']),
  key((props) => props.frameId),
  props({} as SDCardModalLogicProps),
  actions({
    buildSDCard: true,
    openSDCardModal: true,
    closeSDCardModal: true,
  }),
  reducers({
    showSDCardModal: [
      false,
      {
        openSDCardModal: () => true,
        closeSDCardModal: () => false,
        buildSDCard: () => false,
      },
    ],
  }),
  listeners(({ props }) => ({
    buildSDCard: () => framesModel.actions.buildSDCard(props.frameId),
  })),
])
