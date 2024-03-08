import { useActions, useValues } from 'kea'
import { categoryLabels } from '../../../../models/appsModel'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { appsLogic } from './appsLogic'
import { TextInput } from '../../../../components/TextInput'
import React from 'react'

export function Apps() {
  const { appsByCategory, search } = useValues(appsLogic)
  const { setSearch } = useActions(appsLogic)
  const onDragStart = (event: any, keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type: 'app', keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div className="space-y-4">
      <TextInput placeholder="Search apps..." onChange={setSearch} value={search} />
      {Object.entries(appsByCategory).map(([category, apps]) => (
        <div className="space-y-2">
          <H6 className="capitalize">{categoryLabels[category] ?? category}</H6>
          {Object.entries(apps).map(([keyword, { name, description }]) => (
            <Box
              key={keyword}
              className="bg-gray-900 px-3 py-2 dndnode flex items-center justify-between space-x-2 cursor-move"
              draggable
              onDragStart={(event) => onDragStart(event, keyword)}
            >
              <div>
                <H6>{name}</H6>
                <div className="text-sm">{description}</div>
              </div>
            </Box>
          ))}
        </div>
      ))}
    </div>
  )
}
