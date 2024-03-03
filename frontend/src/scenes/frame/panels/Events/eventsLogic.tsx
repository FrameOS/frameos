import { actions, kea, path, reducers, selectors } from 'kea'
import type { eventsLogicType } from './eventsLogicType'
import _events from '../../../../../schema/events.json'
import { FrameEvent } from '../../../../types'

const events: FrameEvent[] = _events as any

export const eventsLogic = kea<eventsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Events', 'eventsLogic']),
  actions({
    showListen: true,
    showDispatch: true,
  }),
  reducers({
    tab: [
      'listen' as 'listen' | 'dispatch',
      {
        showListen: () => 'listen',
        showDispatch: () => 'dispatch',
      },
    ],
  }),
  selectors({
    events: [
      (s) => [s.tab],
      (tab): FrameEvent[] => {
        return tab === 'listen'
          ? events.filter((event) => event.canListen)
          : events.filter((event) => event.canDispatch)
      },
    ],
  }),
])
