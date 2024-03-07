import { actions, kea, path, reducers, selectors } from 'kea'
import type { eventsLogicType } from './eventsLogicType'
import _events from '../../../../../schema/events.json'
import { FrameEvent } from '../../../../types'
import { searchInText } from '../../../../utils/searchInText'

const events: FrameEvent[] = _events as any

export const eventsLogic = kea<eventsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Events', 'eventsLogic']),
  actions({
    showListen: true,
    showDispatch: true,
    setSearch: (search: string) => ({ search }),
  }),
  reducers({
    tab: [
      'listen' as 'listen' | 'dispatch',
      {
        showListen: () => 'listen',
        showDispatch: () => 'dispatch',
      },
    ],
    search: ['', { setSearch: (_, { search }) => search }],
  }),
  selectors({
    events: [
      (s) => [s.tab, s.search],
      (tab, search): FrameEvent[] => {
        return (
          tab === 'listen' ? events.filter((event) => event.canListen) : events.filter((event) => event.canDispatch)
        ).filter((event) => searchInText(search, event.name) || searchInText(search, event.description))
      },
    ],
    tabCounts: [
      (s) => [s.search],
      (search): Record<'listen' | 'dispatch', number> => {
        return {
          listen: events
            .filter((event) => event.canListen)
            .filter((event) => searchInText(search, event.name) || searchInText(search, event.description)).length,
          dispatch: events
            .filter((event) => event.canDispatch)
            .filter((event) => searchInText(search, event.name) || searchInText(search, event.description)).length,
        }
      },
    ],
  }),
])
