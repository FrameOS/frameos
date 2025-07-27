import { actions, kea, reducers, path, props, key, listeners } from 'kea'

import type { sdCardModalLogicType } from './sdCardModalLogicType'
import { framesModel } from '../../../models/framesModel'
import { forms } from 'kea-forms'

export interface SDCardModalLogicProps {
  frameId: number
}

export interface SDCardModalForm {
  timezone: string
  hostname: string
  wifiSsid: string
  wifiPassword: string
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
  forms(({ actions }) => ({
    sdCardForm: {
      defaults: {
        timezone: 'UTC',
        hostname: '',
        wifiSsid: '',
        wifiPassword: '',
      } as SDCardModalForm,
      submit: () => actions.buildSDCard(),
    },
  })),
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
