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
import { AppConfig } from '../../../../types'
import { appTag } from '../../../../utils/sceneApps'

export function Apps() {
  const { frameId } = useValues(frameLogic)
  const logic = appsLogic({ frameId })
  const { appsByCategory, search, visibleSceneApps } = useValues(logic)
  const { setSearch } = useActions(logic)
  const { scenesOpen } = useValues(panelsLogic({ frameId }))
  const onDragStart = (event: any, keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type: 'app', keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  const renderApp = (keyword: string, app: AppConfig) => {
    const tag = appTag(app)
    return (
      <Box
        key={keyword}
        className="bg-gray-900 px-3 py-2 dndnode flex items-center justify-between space-x-2 cursor-move w-full"
        draggable
        onDragStart={(event) => onDragStart(event, keyword)}
      >
        <div className="w-full">
          <div className="flex items-start justify-between">
            <H6>
              {app.name}
              {tag ? <span className="ml-2 text-xs font-normal text-gray-400">[{tag}]</span> : null}
            </H6>
            {app.output?.map((output, i) => (
              <FieldTypeTag key={i} className="mt-1" type={output.type} />
            ))}
          </div>
          <div className="text-sm">{app.description}</div>
        </div>
      </Box>
    )
  }
  return (
    <div className="space-y-4">
      <TextInput placeholder="Search apps..." onChange={setSearch} value={search} />
      {scenesOpen ? (
        <div className="text-xs text-gray-400">
          Apps can only be dragged onto the scene editor or into AI generation prompts.
        </div>
      ) : null}
      {!scenesOpen && Object.keys(visibleSceneApps).length > 0 ? (
        <div className="space-y-2">
          <H6>Scene apps</H6>
          {Object.entries(visibleSceneApps)
            .toSorted(([, a], [, b]) => a.name.localeCompare(b.name))
            .map(([keyword, app]) => renderApp(keyword, app))}
        </div>
      ) : null}
      {Object.entries(appsByCategory).map(([category, apps]) => (
        <div className="space-y-2" key={category}>
          <H6 className="capitalize">{categoryLabels[category] ?? category}</H6>
          {Object.entries(apps)
            .toSorted(([, a], [, b]) => a.name.localeCompare(b.name))
            .map(([keyword, app]) => renderApp(keyword, app))}
        </div>
      ))}
    </div>
  )
}
