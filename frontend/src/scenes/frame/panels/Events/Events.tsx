import { useActions, useValues } from 'kea'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'

import { eventsLogic } from './eventsLogic'
import { Tabs } from '../../../../components/panels/Tabs'
import { Tab } from '../../../../components/panels/Tab'
import { TextInput } from '../../../../components/TextInput'
import React from 'react'

export function Events() {
  const { tab, events, search, tabCounts } = useValues(eventsLogic)
  const { showDispatch, showListen, setSearch } = useActions(eventsLogic)

  const onDragStart = (event: any, type: 'event' | 'dispatch', keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type, keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className="space-y-2">
      <TextInput placeholder="Search events..." onChange={setSearch} value={search} />
      <Tabs className="frameos-divider border border-t-0 border-l-0 border-r-0 border-b-1 pl-2">
        <Tab
          onClick={showListen}
          active={tab === 'listen'}
          activeColorClass="frameos-primary-active"
          className="mb-[-1px]"
        >
          Listen ({tabCounts.listen})
        </Tab>
        <Tab
          onClick={showDispatch}
          active={tab === 'dispatch'}
          activeColorClass="frameos-primary-active"
          className="mb-[-1px]"
        >
          Dispatch ({tabCounts.dispatch})
        </Tab>
      </Tabs>

      {Object.values(events)
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map(({ name, description, fields }) => (
          <Box
            key={name}
            className="frame-tool-row dndnode flex cursor-move items-stretch gap-3 py-2 pl-0.5 pr-3"
            draggable
            onDragStart={(event) => onDragStart(event, tab === 'listen' ? 'event' : 'dispatch', name)}
          >
            <div className="frame-tool-drag-handle" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex w-full items-center justify-between">
                <H6>{name}</H6>
              </div>
              <div className="text-sm">
                {description}
                {fields && fields.length > 0 ? ' (' + fields.map((f) => `${f.name}: ${f.type}`).join(', ') + ')' : ''}
              </div>
            </div>
          </Box>
        ))}
      {events.length === 0 ? (
        search === '' ? (
          <div>No events found</div>
        ) : (
          <div>No events found for "{search}"</div>
        )
      ) : null}
    </div>
  )
}
