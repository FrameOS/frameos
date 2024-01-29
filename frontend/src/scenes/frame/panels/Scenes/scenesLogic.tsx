import { afterMount, connect, kea, key, listeners, path, props, selectors } from 'kea'

import { loaders } from 'kea-loaders'
import { frameLogic } from '../../frameLogic'

import type { scenesLogicType } from './scenesLogicType'

export interface ScenesLogicProps {
  frameId: number
}

export const scenesLogic = kea<scenesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'scenesLogic']),
  props({} as ScenesLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: ScenesLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['setFrameFormValues', 'applyTemplate']],
  })),
  selectors({
    scenes: [(s) => [s.frame], (frame) => frame.scenes],
  }),
])
