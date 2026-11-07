import clsx from 'clsx'
import { useActions, useMountedLogic, useValues } from 'kea'
import type { MouseEvent, ReactNode } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronDoubleLeftIcon,
  CodeBracketIcon,
  CubeIcon,
  DocumentTextIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  RectangleGroupIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'

import type { FrameScene } from '../types'
import { editAppLogic } from '../scenes/frame/panels/EditApp/editAppLogic'
import { javascriptAppSourceFiles } from '../utils/sceneApps'
import { appTreeKey, sceneAppEntries, sceneFileName, sceneTreeKey, type SceneAppEntry } from './sceneFiles'
import { sceneFileTreeLogic } from './sceneFileTreeLogic'

const indent = 14

function TreeRow({
  depth,
  active,
  icon,
  label,
  suffix,
  title,
  expanded,
  onToggle,
  onClick,
  actions,
  testId,
}: {
  depth: number
  active?: boolean
  icon: ReactNode
  label: ReactNode
  suffix?: ReactNode
  title?: string
  /** undefined: a leaf (no chevron). */
  expanded?: boolean
  onToggle?: () => void
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  actions?: ReactNode
  testId?: string
}): JSX.Element {
  return (
    <div
      className={clsx(
        'scene-file-tree__row app-file-row group flex h-7 items-center gap-1 rounded-md pr-1 text-[13px]',
        active && 'app-file-row-active'
      )}
      style={{ paddingLeft: 4 + depth * indent }}
      data-testid={testId}
    >
      {expanded === undefined ? (
        <span className="w-4 shrink-0" />
      ) : (
        <button
          type="button"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={onToggle}
          className="frameos-muted flex h-4 w-4 shrink-0 items-center justify-center rounded"
        >
          {expanded ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
        </button>
      )}
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus:outline-none"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 truncate">{label}</span>
        {suffix}
      </button>
      {actions ? <span className="hidden shrink-0 items-center group-hover:flex">{actions}</span> : null}
    </div>
  )
}

function fileIcon(file: string): JSX.Element {
  return /\.(ts|tsx|js|jsx|nim)$/.test(file) ? (
    <CodeBracketIcon className="h-4 w-4 text-sky-500" />
  ) : (
    <DocumentTextIcon className="h-4 w-4 text-amber-500" />
  )
}

/** An expanded app folder: mounts the app's editAppLogic (which loads its
 * files, built-in ones over the network) and lists them. */
function AppFolderFiles({
  frameId,
  sceneId,
  entry,
  depth,
  activeApp,
  onOpenFile,
}: {
  frameId: number
  sceneId: string
  entry: SceneAppEntry
  depth: number
  activeApp: boolean
  onOpenFile: (file: string, event?: MouseEvent<HTMLButtonElement>) => void
}): JSX.Element {
  const logicProps = { frameId, sceneId, nodeId: entry.nodeId }
  useMountedLogic(editAppLogic(logicProps))
  const { filenames, sourcesLoading, activeFile, changedFiles, modelMarkers } = useValues(editAppLogic(logicProps))
  const { addFile, deleteFile } = useActions(editAppLogic(logicProps))
  if (sourcesLoading) {
    return (
      <div className="frameos-muted py-1 text-xs" style={{ paddingLeft: 4 + (depth + 1) * indent + 20 }}>
        Loading files…
      </div>
    )
  }
  const removable = (file: string): boolean =>
    entry.source === 'scene' && ![...javascriptAppSourceFiles, 'app.nim', 'config.json'].includes(file)
  return (
    <>
      {filenames.map((file) => (
        <TreeRow
          key={file}
          depth={depth}
          active={activeApp && activeFile === file}
          icon={fileIcon(file)}
          label={
            <span className={clsx(modelMarkers[file]?.length ? 'text-red-500' : null)}>
              {file}
              {changedFiles[file] ? <span className="ml-1 font-bold">•</span> : null}
            </span>
          }
          title={
            modelMarkers[file]?.length
              ? `line ${modelMarkers[file][0].startLineNumber}: ${modelMarkers[file][0].message}`
              : file
          }
          onClick={(event) => onOpenFile(file, event)}
          actions={
            removable(file) ? (
              <button
                type="button"
                title={`Delete ${file}`}
                aria-label={`Delete ${file}`}
                className="frameos-muted flex h-5 w-5 items-center justify-center rounded hover:text-red-500"
                onClick={() => {
                  if (window.confirm(`Are you sure you want to delete ${file}?`)) {
                    deleteFile(file)
                  }
                }}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            ) : null
          }
        />
      ))}
      {entry.source === 'scene' ? (
        <TreeRow
          depth={depth}
          icon={<PlusIcon className="h-3.5 w-3.5" />}
          label={<span className="frameos-muted">Add file</span>}
          onClick={() => {
            onOpenFile(activeFile)
            addFile()
          }}
        />
      ) : null}
    </>
  )
}

export interface SceneFileTreeProps {
  frameId: number
  scenes: FrameScene[]
  /** The scene the editor shows (its diagram, or the scene of the app open). */
  selectedSceneId: string | null
  onSelectScene: (sceneId: string) => void
  /** The shell's surface colour: the tree lies over the file when the
   * editor is narrow, and must not be see-through there. */
  surfaceClassName?: string
}

/** A narrow editor draws the tree over the file (see the nav's classes):
 * picking a file there puts it away, as a phone's file drawer does. */
function closeIfOverlay(event: MouseEvent<HTMLElement> | undefined, close: () => void): void {
  const nav = event?.currentTarget.closest('.scene-file-tree')
  if (nav && window.getComputedStyle(nav).position === 'absolute') {
    close()
  }
}

// The embedded editor's left column: template.json, then every scene of the
// template as a diagram, each with its app nodes as folders of files.
export function SceneFileTree({
  frameId,
  scenes,
  selectedSceneId,
  onSelectScene,
  surfaceClassName,
}: SceneFileTreeProps): JSX.Element {
  const logic = sceneFileTreeLogic({ frameId })
  const { shownSelection, isExpanded } = useValues(logic)
  const { selectTemplate, showDiagram, toggleExpanded, openAppFile, setTreeOpen } = useActions(logic)

  return (
    <nav
      aria-label="Template files"
      className={clsx(
        'scene-file-tree frameos-divider absolute inset-y-0 left-0 z-[70] flex w-60 max-w-[85%] shrink-0 flex-col border-r shadow-2xl',
        '@2xl:static @2xl:z-auto @2xl:max-w-none @2xl:shadow-none',
        surfaceClassName
      )}
      data-testid="scene-file-tree"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 pl-3 pr-1.5">
        <div className="frameos-muted min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide">
          Files
        </div>
        <button
          type="button"
          title="Hide the files"
          aria-label="Hide the files"
          onClick={() => setTreeOpen(false)}
          className="frameos-icon-button frameos-muted flex h-7 w-7 items-center justify-center rounded-lg"
        >
          <ChevronDoubleLeftIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-3">
        <TreeRow
          depth={0}
          active={shownSelection.kind === 'template'}
          icon={<DocumentTextIcon className="h-4 w-4 text-amber-500" />}
          label="template.json"
          title="The template's name, description, category and tags"
          onClick={(event) => {
            selectTemplate()
            closeIfOverlay(event, () => setTreeOpen(false))
          }}
          testId="scene-file-template"
        />
        {scenes.map((scene) => {
          const apps = sceneAppEntries(scene)
          const sceneKey = sceneTreeKey(scene.id)
          const sceneExpanded = isExpanded(sceneKey)
          return (
            <div key={scene.id}>
              <TreeRow
                depth={0}
                active={shownSelection.kind === 'diagram' && selectedSceneId === scene.id}
                icon={<RectangleGroupIcon className="h-4 w-4 text-violet-500" />}
                label={sceneFileName(scene)}
                title={`The diagram of "${scene.name || scene.id}"`}
                expanded={apps.length > 0 ? sceneExpanded : undefined}
                onToggle={() => toggleExpanded(sceneKey)}
                onClick={(event) => {
                  onSelectScene(scene.id)
                  showDiagram(scene.id)
                  closeIfOverlay(event, () => setTreeOpen(false))
                }}
                testId="scene-file-scene"
              />
              {apps.length > 0 && sceneExpanded
                ? apps.map((entry) => {
                    const appKey = appTreeKey(scene.id, entry.nodeId)
                    const appExpanded = isExpanded(appKey)
                    const activeApp =
                      shownSelection.kind === 'app' &&
                      shownSelection.sceneId === scene.id &&
                      shownSelection.nodeId === entry.nodeId
                    return (
                      <div key={entry.nodeId}>
                        <TreeRow
                          depth={1}
                          active={activeApp && !appExpanded}
                          icon={
                            entry.source === 'builtin' ? (
                              <CubeIcon className="h-4 w-4 text-slate-400" />
                            ) : appExpanded ? (
                              <FolderOpenIcon className="h-4 w-4 text-sky-500" />
                            ) : (
                              <FolderIcon className="h-4 w-4 text-sky-500" />
                            )
                          }
                          label={entry.label}
                          suffix={
                            entry.source === 'builtin' ? (
                              <span className="frameos-muted shrink-0 text-[10px] uppercase tracking-wide">
                                built-in
                              </span>
                            ) : null
                          }
                          title={entry.keyword ? `${entry.label} (${entry.keyword})` : entry.label}
                          expanded={appExpanded}
                          onToggle={() => toggleExpanded(appKey)}
                          onClick={() => toggleExpanded(appKey)}
                          testId="scene-file-app"
                        />
                        {appExpanded ? (
                          <AppFolderFiles
                            frameId={frameId}
                            sceneId={scene.id}
                            entry={entry}
                            depth={2}
                            activeApp={activeApp}
                            onOpenFile={(file, event) => {
                              onSelectScene(scene.id)
                              openAppFile(scene.id, entry.nodeId, file)
                              closeIfOverlay(event, () => setTreeOpen(false))
                            }}
                          />
                        ) : null}
                      </div>
                    )
                  })
                : null}
            </div>
          )
        })}
      </div>
    </nav>
  )
}
