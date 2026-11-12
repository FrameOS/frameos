import { BindLogic, useActions, useMountedLogic, useValues } from 'kea'
import { useEffect, type ComponentType } from 'react'
import {
  BoltIcon,
  CodeBracketIcon,
  Cog6ToothIcon,
  PuzzlePieceIcon,
  ServerStackIcon,
  VariableIcon,
} from '@heroicons/react/24/outline'

import type { FrameId, FrameScene, FrameType } from '../../types'
import { sceneIsCompiledForFrame } from '../../utils/sceneExecution'
import { withIsLayout } from '../../utils/sceneLayouts'
import { SceneEditorBody, SceneEditorInfoPanel, type SceneEditorPanel } from '../../embed/SceneEditorBody'
import { sceneFileTreeLogic } from '../../embed/sceneFileTreeLogic'
import type { SceneWorkspaceEditorProps } from '../../sceneWorkspace/SceneEditorWorkspace'
import { frameLogic } from '../frame/frameLogic'
import { frameEditorsLogic } from '../frame/frameEditorsLogic'
import { diagramLogic } from '../frame/panels/Diagram/diagramLogic'
import { Apps } from '../frame/panels/Apps/Apps'
import { Events } from '../frame/panels/Events/Events'
import { SceneJSON } from '../frame/panels/SceneJSON/SceneJSON'
import { SceneSource } from '../frame/panels/SceneSource/SceneSource'
import { SceneState } from '../frame/panels/SceneState/SceneState'
import { workspaceLogic, type WorkspaceUtilityPanel } from './workspaceLogic'
import { sceneUtilityPanelIsAllowed, workspaceMode } from './workspaceSurfaces'

// The diagram's side panels, the store editor's set (its Preview is the
// workspace's own column): keyed by the workspace's utility panel names (the
// URL's drawer hash, openWorkspaceSceneUtility), filtered by the control
// plane's allow-list (workspaceSurfaces.ts). Source shows generated Nim, so
// only a compiled scene has it.
function framePanels(frameId: FrameId, frame: FrameType, scene: FrameScene | null): SceneEditorPanel[] {
  const panels: (SceneEditorPanel & { panel: WorkspaceUtilityPanel })[] = [
    {
      panel: 'info',
      label: 'Scene settings',
      icon: <Cog6ToothIcon className="h-5 w-5" />,
      render: (scene) => <SceneEditorInfoPanel frameId={frameId} scene={scene} />,
    },
    {
      panel: 'stateVariables',
      label: 'State variables',
      icon: <VariableIcon className="h-5 w-5" />,
      render: (scene) => <SceneState sceneId={scene.id} />,
    },
    { panel: 'apps', label: 'Apps', icon: <PuzzlePieceIcon className="h-5 w-5" />, render: () => <Apps /> },
    {
      panel: 'events',
      label: 'Events',
      icon: <BoltIcon className="h-5 w-5" />,
      render: (scene) => <Events frameId={frameId} sceneId={scene.id} />,
    },
    { panel: 'source', label: 'Source', icon: <CodeBracketIcon className="h-5 w-5" />, render: () => <SceneSource /> },
    {
      panel: 'json',
      label: 'JSON',
      icon: <ServerStackIcon className="h-5 w-5" />,
      render: (scene) => <SceneJSON sceneId={scene.id} />,
    },
  ]
  const mode = workspaceMode()
  return panels.filter(
    (definition) =>
      sceneUtilityPanelIsAllowed(mode, definition.panel) &&
      (definition.panel !== 'source' || sceneIsCompiledForFrame(scene, frame.mode))
  )
}

/** Selects the node the route names (?nodeId=, from an app's "Back to
 * scene") once the diagram has it. */
function SceneSelectedNodeSync({ frameId, sceneId }: { frameId: FrameId; sceneId: string }): null {
  const { selectedNodeId } = useValues(workspaceLogic)
  const diagram = diagramLogic({ frameId, sceneId })
  const { nodes } = useValues(diagram)
  const { selectNode } = useActions(diagram)

  useEffect(() => {
    if (!selectedNodeId) {
      return
    }
    const target = nodes.find((node) => node.id === selectedNodeId)
    if (!target) {
      return
    }
    const onlyTargetSelected = target.selected && nodes.every((node) => node.id === selectedNodeId || !node.selected)
    if (!onlyTargetSelected) {
      selectNode(selectedNodeId)
    }
  }, [nodes, selectNode, selectedNodeId])

  return null
}

function FrameSceneEditor({ frameId, ...props }: SceneWorkspaceEditorProps & { frameId: FrameId }): JSX.Element | null {
  const logicProps = { frameId }
  useMountedLogic(sceneFileTreeLogic(logicProps))
  const { frame, scenes } = useValues(frameLogic(logicProps))
  const { updateScene } = useActions(frameLogic(logicProps))
  const { utilityPanel } = useValues(workspaceLogic)
  const { openUtilityPanel, closeUtilityPanel } = useActions(workspaceLogic)
  const sceneId = props.sceneId ?? null
  const scene = scenes.find((candidate) => candidate.id === sceneId) ?? null

  // What the workspace drives (the bar's rename, keeping the diagram centred
  // as the columns change): the shown scene's diagram.
  const apiRef = props.apiRef
  useEffect(() => {
    if (!apiRef) {
      return
    }
    const shownDiagram = () => (sceneId ? diagramLogic.findMounted({ frameId, sceneId }) : null)
    apiRef.current = {
      renameScene: (id, name) => updateScene(id, { name }),
      setSceneIsLayout: (id, isLayout) => {
        const target = frameLogic.findMounted({ frameId })?.values.scenes?.find((candidate) => candidate.id === id)
        updateScene(id, { settings: withIsLayout(target?.settings, isLayout) })
      },
      panBy: (dx, dy) => shownDiagram()?.actions.panDiagramView(dx, dy),
      fitView: () => shownDiagram()?.actions.fitDiagramView(),
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, frameId, sceneId, updateScene])

  if (!frame || !scene) {
    return null
  }
  return (
    <BindLogic logic={frameLogic} props={logicProps}>
      <BindLogic logic={frameEditorsLogic} props={logicProps}>
        {/* One scene at a time: its folder alone (its diagram and its apps). */}
        <SceneEditorBody
          frameId={frameId}
          selectedSceneId={scene.id}
          setSelectedSceneId={() => {}}
          scenes={[scene]}
          theme={props.theme ?? 'light'}
          panels={framePanels(frameId, frame, scene)}
          template={null}
          nested
          activePanel={utilityPanel}
          onActivePanelChange={(panel) =>
            panel ? openUtilityPanel(panel as WorkspaceUtilityPanel) : closeUtilityPanel()
          }
        />
        <SceneSelectedNodeSync frameId={frameId} sceneId={scene.id} />
      </BindLogic>
    </BindLogic>
  )
}

const columns = new Map<string, ComponentType<SceneWorkspaceEditorProps>>()

/** The workspace's editor column for one frame: the scene editor over the
 * frame's own frameLogic (the store's runs one in memory). The same
 * component for the same frame, so the column keeps its state. */
export function frameSceneEditorColumn(frameId: FrameId): ComponentType<SceneWorkspaceEditorProps> {
  const key = String(frameId)
  let column = columns.get(key)
  if (!column) {
    column = function FrameSceneEditorColumn(props: SceneWorkspaceEditorProps): JSX.Element | null {
      return <FrameSceneEditor frameId={frameId} {...props} />
    }
    columns.set(key, column)
  }
  return column
}
