import { useActions, useValues } from 'kea'
import { categoryLabels } from '../../../../models/appsModel'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { appsLogic } from './appsLogic'
import { TextInput } from '../../../../components/TextInput'
import React from 'react'
import { FieldTypeTag } from '../../../../components/FieldTypeTag'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'

export function Apps() {
  const { appsByCategory, search } = useValues(appsLogic)
  const { setSearch } = useActions(appsLogic)
  const { frameId } = useValues(frameLogic)
  const { scenesOpen } = useValues(panelsLogic({ frameId }))
  const onDragStart = (event: any, keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type: 'app', keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div className="space-y-4">
      <TextInput placeholder="Search apps..." onChange={setSearch} value={search} />
      {scenesOpen ? (
        <div className="text-xs text-gray-400">
          Apps can only be dragged onto the scene editor or into AI generation prompts.
        </div>
      ) : null}
      {Object.entries(appsByCategory).map(([category, apps]) => (
        <div className="space-y-2" key={category}>
          <H6 className="capitalize">{categoryLabels[category] ?? category}</H6>
          {Object.entries(apps)
            .toSorted(([, a], [, b]) => a.name.localeCompare(b.name))
            .map(([keyword, app]) => (
              <Box
                key={keyword}
                className="bg-gray-900 px-3 py-2 dndnode flex items-center justify-between space-x-2 cursor-move w-full"
                draggable
                onDragStart={(event) => onDragStart(event, keyword)}
              >
                <div className="w-full">
                  <div className="flex items-start justify-between">
                    <H6>{app.name}</H6>
                    {app.output?.map((output, i) => (
                      <FieldTypeTag key={i} className="mt-1" type={output.type} />
                    ))}
                  </div>
                  <div className="text-sm">{app.description}</div>
                </div>
              </Box>
            ))}
        </div>
      ))}
    </div>
  )
}
