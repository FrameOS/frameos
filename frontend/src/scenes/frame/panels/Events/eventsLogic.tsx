import { actions, kea, path, reducers, selectors } from 'kea'
import type { eventsLogicType } from './eventsLogicType'
import _events from './events.json'
import { FrameEvent } from '../../../../types'

const events: Record<string, FrameEvent> = _events as any

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
          ? Object.values(events).filter((event) => event.type === 'input' || event.type === 'both')
          : Object.values(events).filter((event) => event.type === 'output' || event.type === 'both')
      },
    ],
  }),
])
