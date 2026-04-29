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
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { TrashIcon } from '@heroicons/react/24/solid'

export function Apps() {
  const { frameId } = useValues(frameLogic)
  const logic = appsLogic({ frameId })
  const { appsByCategory, search, visibleSceneApps, sceneAppUsageCounts } = useValues(logic)
  const { setSearch, deleteUnusedSceneApp } = useActions(logic)
  const { scenesOpen } = useValues(panelsLogic({ frameId }))
  const onDragStart = (event: any, keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type: 'app', keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }
  const renderApp = (keyword: string, app: AppConfig, usageCount?: number) => {
    const tag = appTag(app)
    const isUnusedSceneApp = usageCount === 0
    return (
      <Box
        key={keyword}
        className="bg-gray-900 px-3 py-2 dndnode flex items-center justify-between space-x-2 cursor-move w-full"
        draggable
        onDragStart={(event) => onDragStart(event, keyword)}
      >
        <div className="w-full">
          <div className="flex items-start justify-between gap-2">
            <H6 className="min-w-0 flex-1 break-words">
              {app.name}
              {tag ? <span className="ml-2 text-xs font-normal text-gray-400">[{tag}]</span> : null}
            </H6>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {typeof usageCount === 'number' ? (
                <span className="mt-1 whitespace-nowrap rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-200">
                  {usageCount} use{usageCount === 1 ? '' : 's'}
                </span>
              ) : null}
              {app.output?.map((output, i) => (
                <FieldTypeTag key={i} className="mt-1" type={output.type} />
              ))}
              {isUnusedSceneApp ? (
                <DropdownMenu
                  className="mt-0.5"
                  buttonColor="none"
                  horizontal
                  items={[
                    {
                      label: 'Delete app',
                      confirm: `Delete "${app.name}" from this scene?`,
                      onClick: () => deleteUnusedSceneApp(keyword),
                      icon: <TrashIcon className="w-5 h-5" />,
                    },
                  ]}
                />
              ) : null}
            </div>
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
            .map(([keyword, app]) => renderApp(keyword, app, sceneAppUsageCounts[keyword] ?? 0))}
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
