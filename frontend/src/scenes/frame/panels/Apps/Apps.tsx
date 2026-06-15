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
import { appCompatibilityForFrame, type CompatibilityResult } from '../../../../utils/embeddedCompatibility'
import clsx from 'clsx'

interface CompatibleAppRow {
  keyword: string
  app: AppConfig
  compatibility: CompatibilityResult
  sources?: Record<string, string> | null
  usageCount?: number
}

function sortCompatibleApps(a: CompatibleAppRow, b: CompatibleAppRow): number {
  if (a.compatibility.supported !== b.compatibility.supported) {
    return a.compatibility.supported ? -1 : 1
  }
  if (a.keyword === INLINE_CODE_NODE_KEYWORD) {
    return -1
  }
  if (b.keyword === INLINE_CODE_NODE_KEYWORD) {
    return 1
  }
  return a.app.name.localeCompare(b.app.name)
}

export function Apps() {
  const { frameId, mode } = useValues(frameLogic)
  const logic = appsLogic({ frameId })
  const { appsByCategory, search, visibleSceneApps, rawSceneApps, sceneAppUsageCounts } = useValues(logic)
  const { setSearch, deleteUnusedSceneApp } = useActions(logic)
  const { scenesOpen } = useValues(frameEditorsLogic({ frameId }))
  const onDragStart = (event: any, keyword: string) => {
    const dragData = keyword === INLINE_CODE_NODE_KEYWORD ? { type: 'code', keyword: '' } : { type: 'app', keyword }
    event.dataTransfer.setData('application/reactflow', JSON.stringify(dragData))
    event.dataTransfer.effectAllowed = 'move'
  }
  const renderApp = (
    keyword: string,
    app: AppConfig,
    usageCount?: number,
    sources?: Record<string, string> | null,
    compatibility: CompatibilityResult = appCompatibilityForFrame(mode, keyword, app, sources)
  ) => {
    const tag = appTag(app)
    const isUnusedSceneApp = usageCount === 0
    const unsupported = !compatibility.supported
    return (
      <Box
        key={keyword}
        className={clsx(
          'frame-tool-row dndnode flex w-full items-stretch gap-3 py-2 pl-0.5 pr-3',
          unsupported ? 'cursor-not-allowed opacity-50 grayscale' : 'cursor-move'
        )}
        draggable={!unsupported}
        title={unsupported ? compatibility.reason : undefined}
        onDragStart={(event) => {
          if (unsupported) {
            event.preventDefault()
            return
          }
          onDragStart(event, keyword)
        }}
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
              {unsupported ? (
                <span className="mt-1 whitespace-nowrap rounded bg-slate-200 px-1.5 py-0.5 text-xs font-semibold text-slate-500">
                  ESP32 unsupported
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
          {unsupported ? <div className="mt-1 text-xs font-medium text-slate-500">{compatibility.reason}</div> : null}
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
            .map(([keyword, app]) => {
              const sources = rawSceneApps[keyword]?.sources
              return {
                keyword,
                app,
                sources,
                usageCount: sceneAppUsageCounts[keyword] ?? 0,
                compatibility: appCompatibilityForFrame(mode, keyword, app, sources),
              }
            })
            .toSorted(sortCompatibleApps)
            .map(({ keyword, app, usageCount, sources, compatibility }) =>
              renderApp(keyword, app, usageCount, sources, compatibility)
            )}
        </div>
      ) : null}
      {Object.entries(appsByCategory).map(([category, apps]) => (
        <div className="space-y-2" key={category}>
          <H6 className="capitalize">{categoryLabels[category] ?? category}</H6>
          {Object.entries(apps)
            .map(([keyword, app]) => ({
              keyword,
              app,
              compatibility: appCompatibilityForFrame(mode, keyword, app),
            }))
            .toSorted(sortCompatibleApps)
            .map(({ keyword, app, compatibility }) => renderApp(keyword, app, undefined, undefined, compatibility))}
        </div>
      ))}
    </div>
  )
}
