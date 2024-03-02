import { useActions, useValues } from 'kea'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'

import { eventsLogic } from './eventsLogic'
import { Tabs } from '../../../../components/panels/Tabs'
import { Tab } from '../../../../components/panels/Tab'

export function Events() {
  const { tab, events } = useValues(eventsLogic)
  const { showDispatch, showListen } = useActions(eventsLogic)

  const onDragStart = (event: any, type: 'event' | 'dispatch', keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type, keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className="space-y-2">
      <Tabs className="border border-t-0 border-l-0 border-r-0 border-b-1 border-gray-700 pl-2">
        <Tab onClick={showListen} active={tab === 'listen'} activeColorClass="bg-[#4a4b8c]" className="mb-[-1px]">
          Listen to an event
        </Tab>
        <Tab onClick={showDispatch} active={tab === 'dispatch'} activeColorClass="bg-[#4a4b8c]" className="mb-[-1px]">
          Dispatch an event
        </Tab>
      </Tabs>

      {Object.values(events).map(({ name, description, fields }) => (
        <Box
          key={name}
          className="bg-gray-900 px-3 py-2 dndnode cursor-move"
          draggable
          onDragStart={(event) => onDragStart(event, tab === 'listen' ? 'event' : 'dispatch', name)}
        >
          <div className="flex items-center justify-between w-full">
            <H6>{name}</H6>
          </div>
          <div className="text-sm">
            {description}
            {fields && fields.length > 0 ? ' (' + fields.map((f) => `${f.name}: ${f.type}`).join(', ') + ')' : ''}
          </div>
        </Box>
      ))}
    </div>
  )
}
