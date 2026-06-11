import { useActions, useValues } from 'kea'
import { categoryLabels } from '../../../../models/appsModel'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { appsLogic, INLINE_CODE_NODE_KEYWORD } from './appsLogic'
import { TextInput } from '../../../../components/TextInput'
import React from 'react'
import { FieldTypeTag } from '../../../../components/FieldTypeTag'
import { frameLogic } from '../../frameLogic'
import { frameEditorsLogic } from '../../frameEditorsLogic'
import { AppConfig } from '../../../../types'
import { appTag } from '../../../../utils/sceneApps'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { TrashIcon } from '@heroicons/react/24/solid'
import { Tooltip } from '../../../../components/Tooltip'

export function Apps() {
  const { frameId } = useValues(frameLogic)
  const logic = appsLogic({ frameId })
  const { appsByCategory, search, visibleSceneApps, sceneAppUsageCounts } = useValues(logic)
  const { setSearch, deleteUnusedSceneApp } = useActions(logic)
  const { scenesOpen } = useValues(frameEditorsLogic({ frameId }))
  const onDragStart = (event: any, keyword: string) => {
    const dragData = keyword === INLINE_CODE_NODE_KEYWORD ? { type: 'code', keyword: '' } : { type: 'app', keyword }
    event.dataTransfer.setData('application/reactflow', JSON.stringify(dragData))
    event.dataTransfer.effectAllowed = 'move'
  }
  const renderApp = (keyword: string, app: AppConfig, usageCount?: number) => {
    const tag = appTag(app)
    const isUnusedSceneApp = usageCount === 0
    return (
      <Box
        key={keyword}
        className="frame-tool-row dndnode flex w-full cursor-move items-stretch gap-3 py-2 pl-0.5 pr-3"
        draggable
        onDragStart={(event) => onDragStart(event, keyword)}
      >
        <div className="frame-tool-drag-handle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <H6 className="min-w-0 flex-1 break-words">
              {app.name}
              {tag ? <span className="frame-tool-muted ml-2 text-xs font-normal">[{tag}]</span> : null}
            </H6>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {typeof usageCount === 'number' ? (
                <span className="frameos-tag mt-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs">
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
      {!scenesOpen && Object.keys(visibleSceneApps).length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <H6>Scene apps</H6>
            <Tooltip
              className="frameos-tooltip-button cursor-help"
              title="Scene apps are saved with this scene. Their source files are included in the scene data and inlined when the scene runs, exports, or deploys, so edits here do not change the global app catalog."
              titleClassName="w-72"
            />
          </div>
          {Object.entries(visibleSceneApps)
            .toSorted(([, a], [, b]) => a.name.localeCompare(b.name))
            .map(([keyword, app]) => renderApp(keyword, app, sceneAppUsageCounts[keyword] ?? 0))}
        </div>
      ) : null}
      {Object.entries(appsByCategory).map(([category, apps]) => (
        <div className="space-y-2" key={category}>
          <H6 className="capitalize">{categoryLabels[category] ?? category}</H6>
          {Object.entries(apps)
            .toSorted(([keywordA, a], [keywordB, b]) =>
              keywordA === INLINE_CODE_NODE_KEYWORD
                ? -1
                : keywordB === INLINE_CODE_NODE_KEYWORD
                ? 1
                : a.name.localeCompare(b.name)
            )
            .map(([keyword, app]) => renderApp(keyword, app))}
        </div>
      ))}
    </div>
  )
}
