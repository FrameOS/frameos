import 'reactflow/dist/base.css'
import { useActions, useValues, BindLogic } from 'kea'
import ReactFlow, {
  Background,
  BackgroundVariant,
  ReactFlowInstance,
  Connection,
  NodeProps,
  OnConnectStartParams,
  EdgeProps,
  useUpdateNodeInternals,
  ReactFlowProvider,
  SelectionMode,
} from 'reactflow'
import { frameLogic } from '../../frameLogic'
import {
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AppNode } from './AppNode'
import { CodeNode } from './CodeNode'
import { EventNode } from './EventNode'
import { StateNode } from './StateNode'
import { Button } from '../../../../components/Button'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { NodeType, EdgeType, CodeNodeData } from '../../../../types'
import { ArrowsPointingInIcon, EyeIcon } from '@heroicons/react/24/outline'
import { ZoomOutArea } from '../../../../icons/ZoomOutArea'
import { CodeNodeEdge } from './CodeNodeEdge'
import { SceneDropDown } from '../Scenes/SceneDropDown'
import { AppNodeEdge } from './AppNodeEdge'
import { NewNodePicker } from './NewNodePicker'
import { CANVAS_NODE_ID, getNewFieldName, newNodePickerLogic } from './newNodePickerLogic'
import { scenesLogic } from '../Scenes/scenesLogic'
import { CompiledSceneTag } from '../Scenes/CompiledSceneTag'
import { controlLogic } from '../Scenes/controlLogic'
import { PlayIcon } from '@heroicons/react/24/solid'
import { Spinner } from '../../../../components/Spinner'
import { workspaceLogic } from '../../../workspace/workspaceLogic'
import clsx from 'clsx'

const nodeTypes: Record<NodeType, (props: NodeProps) => JSX.Element> = {
  app: AppNode,
  source: AppNode,
  dispatch: AppNode,
  scene: AppNode,
  code: CodeNode,
  event: EventNode,
  state: StateNode,
}

const edgeTypes: Record<EdgeType, (props: EdgeProps) => JSX.Element> = {
  appNodeEdge: AppNodeEdge,
  codeNodeEdge: CodeNodeEdge,
}

interface DiagramProps {
  sceneId: string
  showToolbar?: boolean
}

type DiagramToolbarVariant = 'inline' | 'floating'

interface ConnectingNode {
  nodeId: string | null
  handleType: string | null
  handleId: string | null
}

const floatingToolbarButtonClassName =
  'frameos-icon-button scene-diagram-floating-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/90 bg-white/90 text-slate-500 shadow-lg shadow-slate-300/25 backdrop-blur-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

function FloatingDiagramButton({
  active,
  children,
  disabled,
  onClick,
  title,
}: {
  active?: boolean
  children: JSX.Element
  disabled?: boolean
  onClick: () => void
  title: string
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        floatingToolbarButtonClassName,
        active ? 'frameos-primary-active text-white' : 'bg-white/90 text-slate-500',
        disabled && 'opacity-30'
      )}
    >
      {children}
    </button>
  )
}

export function DiagramToolbar({
  sceneId,
  showSceneAction = true,
  variant = 'inline',
}: {
  sceneId: string
  showSceneAction?: boolean
  variant?: DiagramToolbarVariant
}) {
  const { frameId } = useValues(frameLogic)
  const diagramLogicProps: DiagramLogicProps = { frameId, sceneId }
  const { fitDiagramView, rearrangeCurrentScene } = useActions(diagramLogic(diagramLogicProps))
  const { previewScene } = useActions(scenesLogic({ frameId }))
  const { setCurrentScene } = useActions(controlLogic({ frameId }))
  const { sceneChanging } = useValues(controlLogic({ frameId }))
  const { unsavedSceneIds, undeployedSceneIds, previewingSceneId, linkedActiveSceneId } = useValues(
    scenesLogic({ frameId })
  )
  const sceneHasChanges = unsavedSceneIds.has(sceneId) || undeployedSceneIds.has(sceneId)
  const isPreviewing = previewingSceneId === sceneId
  const isActiveScene = linkedActiveSceneId === sceneId
  const isActivatingScene = sceneChanging === sceneId
  const previewTitle = isPreviewing
    ? 'Previewing scene on the frame'
    : sceneHasChanges
    ? 'Preview unsaved changes on the frame'
    : 'No unsaved changes to preview'
  const floating = variant === 'floating'

  return (
    <div className={clsx('flex items-center gap-2', floating && 'scene-diagram-floating-toolbar')}>
      {showSceneAction ? (
        sceneHasChanges ? (
          floating ? (
            <FloatingDiagramButton
              onClick={() => previewScene(sceneId)}
              title={previewTitle}
              disabled={isPreviewing}
              active={isPreviewing}
            >
              <EyeIcon className="h-5 w-5" />
            </FloatingDiagramButton>
          ) : (
            <Button
              size="tiny"
              onClick={() => previewScene(sceneId)}
              title={previewTitle}
              color="secondary"
              disabled={isPreviewing}
            >
              <EyeIcon className="w-5 h-5" />
            </Button>
          )
        ) : (
          floating ? (
            <FloatingDiagramButton
              onClick={() => setCurrentScene(sceneId)}
              title={isActiveScene ? 'This scene is already active' : 'Activate'}
              disabled={isActiveScene || isActivatingScene}
              active={isActiveScene || isActivatingScene}
            >
              {isActivatingScene ? (
                <Spinner color="white" className="flex h-5 w-5 items-center justify-center" />
              ) : (
                <PlayIcon className="h-5 w-5" />
              )}
            </FloatingDiagramButton>
          ) : (
            <Button
              size="tiny"
              onClick={() => setCurrentScene(sceneId)}
              title={isActiveScene ? 'This scene is already active' : 'Activate'}
              color="primary"
              disabled={isActiveScene || isActivatingScene}
            >
              {isActivatingScene ? (
                <Spinner color="white" className="w-5 h-5 flex items-center justify-center" />
              ) : (
                <PlayIcon className="w-5 h-5" />
              )}
            </Button>
          )
        )
      ) : null}
      {floating ? (
        <>
          <FloatingDiagramButton onClick={fitDiagramView} title="Fit to View">
            <ZoomOutArea className="h-5 w-5" />
          </FloatingDiagramButton>
          <FloatingDiagramButton onClick={rearrangeCurrentScene} title="Realign nodes">
            <ArrowsPointingInIcon className="h-5 w-5" />
          </FloatingDiagramButton>
          <SceneDropDown
            sceneId={sceneId}
            context="editDiagram"
            className={floatingToolbarButtonClassName}
            buttonColor="secondary"
          />
        </>
      ) : (
        <>
          <Button size="tiny" onClick={fitDiagramView} title="Fit to View" color="secondary">
            <ZoomOutArea className="w-5 h-5" />
          </Button>
          <Button size="tiny" onClick={rearrangeCurrentScene} title="Realign nodes" color="secondary">
            <ArrowsPointingInIcon className="w-5 h-5" />
          </Button>
          <SceneDropDown sceneId={sceneId} context="editDiagram" />
        </>
      )}
    </div>
  )
}

function Diagram_({ sceneId, showToolbar = true }: DiagramProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { frameId } = useValues(frameLogic)
  const { theme } = useValues(workspaceLogic)
  const updateNodeInternals = useUpdateNodeInternals()
  const diagramLogicProps: DiagramLogicProps = { frameId, sceneId, updateNodeInternals }
  const { nodes, nodesWithStyle, edges, selectedNodeIds, fitViewCounter, isCompiledScene } = useValues(
    diagramLogic(diagramLogicProps)
  )
  const { onEdgesChange, onNodesChange, setNodes, addEdge, keywordDropped, setCursorPosition } = useActions(
    diagramLogic(diagramLogicProps)
  )
  const { newNodePicker } = useValues(newNodePickerLogic(diagramLogicProps))
  const { openNewNodePicker } = useActions(newNodePickerLogic(diagramLogicProps))
  const highlightedEdges = useMemo(() => {
    if (selectedNodeIds.length === 0) {
      return edges
    }
    const selectedNodeIdSet = new Set(selectedNodeIds)
    return edges.map((edge) => {
      const connectedToSelectedNode = selectedNodeIdSet.has(edge.source) || selectedNodeIdSet.has(edge.target)
      const currentData = edge.data ?? {}
      return currentData.connectedToSelectedNode === connectedToSelectedNode
        ? { ...edge, zIndex: connectedToSelectedNode ? 1 : edge.zIndex }
        : {
            ...edge,
            data: { ...currentData, connectedToSelectedNode },
            zIndex: connectedToSelectedNode ? 1 : edge.zIndex,
          }
    })
  }, [edges, selectedNodeIds])

  const onDragOver = useCallback((event: any) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: any) => {
      event.preventDefault()
      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()
      const reactFlowData = event.dataTransfer.getData('application/reactflow')
      if (!reactFlowData) {
        return
      }
      let keyword: string | undefined
      let type: string | undefined
      try {
        const parsed = JSON.parse(reactFlowData)
        keyword = parsed.keyword
        type = parsed.type
      } catch {
        return
      }
      if (typeof keyword === 'string') {
        const position = reactFlowInstance?.project({
          x: event.clientX - (reactFlowBounds?.left ?? 0),
          y: event.clientY - (reactFlowBounds?.top ?? 0),
        }) ?? { x: 0, y: 0 }
        keywordDropped(keyword, typeof type === 'string' ? type : '', position)
      }
    },
    [reactFlowInstance, nodes]
  )
  const connectingNode = useRef<ConnectingNode | null>(null)

  const onConnect = useCallback(
    (connection: Connection) => {
      connectingNode.current = null
      if (connection.targetHandle === 'codeField/+' && connection.sourceHandle === 'fieldOutput') {
        const nodeId = connection.target
        const codeArgs = (nodes.find((node) => node.id === nodeId)?.data as CodeNodeData)?.codeArgs ?? []
        let newField = getNewFieldName(codeArgs)
        setNodes(
          nodes.map((node) =>
            node.id === nodeId
              ? { ...node, data: { ...node.data, codeArgs: [...codeArgs, { name: newField, type: 'string' }] } }
              : node
          )
        )
        window.requestAnimationFrame(() => {
          addEdge({
            ...connection,
            targetHandle: `codeField/${newField}`,
          })
          if (nodeId) {
            updateNodeInternals(nodeId)
          }
        })
      } else {
        window.requestAnimationFrame(() => {
          addEdge(connection)
        })
      }
    },
    [addEdge, nodes]
  )

  const onConnectStart = useCallback((_: ReactMouseEvent | ReactTouchEvent, params: OnConnectStartParams) => {
    const { nodeId, handleId, handleType } = params
    connectingNode.current = { nodeId, handleId, handleType }
  }, [])

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (!connectingNode.current) return

      const { nodeId, handleId, handleType } = connectingNode.current
      const targetIsDiagramCanvas = (event.target as HTMLElement).classList.contains('react-flow__pane')
      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()

      if (nodeId && handleId && handleType && targetIsDiagramCanvas) {
        const eventCoords = {
          x: 'clientX' in event ? event.clientX : event.touches[0].clientX,
          y: 'clientY' in event ? event.clientY : event.touches[0].clientY,
        }
        const inputCoords = {
          x: eventCoords.x - (reactFlowBounds?.left ?? 0),
          y: eventCoords.y - (reactFlowBounds?.top ?? 0),
        }
        const position = reactFlowInstance?.project(inputCoords) ?? { x: 0, y: 0 }

        event.preventDefault()
        openNewNodePicker(eventCoords.x, eventCoords.y, position.x, position.y, nodeId, handleId, handleType)
      }
    },
    [reactFlowInstance, nodes, edges, setNodes, addEdge]
  )

  const onWheel = useCallback((event: ReactWheelEvent) => {
    const target = event.target as HTMLElement | null
    const focusedTextarea = target?.closest('textarea')
    if (focusedTextarea && focusedTextarea === document.activeElement) {
      event.stopPropagation()
    }
    const monacoEditor = target?.closest('.monaco-editor') as HTMLElement | null
    if (monacoEditor) {
      const nodeWrapper = monacoEditor.closest('.react-flow__node')
      const nodeSelected = nodeWrapper?.classList.contains('selected')
      const editorFocused = document.activeElement ? monacoEditor.contains(document.activeElement) : false
      if (nodeSelected || editorFocused) {
        event.stopPropagation()
      }
    }
  }, [])

  const onContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target as HTMLElement | null
      const pane = target?.closest('.react-flow__pane') as HTMLElement | null
      if (!pane) {
        return
      }
      event.preventDefault()
      if (!reactFlowInstance) {
        return
      }
      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()
      const position = reactFlowInstance.project({
        x: event.clientX - (reactFlowBounds?.left ?? 0),
        y: event.clientY - (reactFlowBounds?.top ?? 0),
      })
      openNewNodePicker(event.clientX, event.clientY, position.x, position.y, CANVAS_NODE_ID, 'canvas', 'canvas')
    },
    [openNewNodePicker, reactFlowInstance]
  )

  const onMouseMove = useCallback(
    (event: ReactMouseEvent) => {
      if (!reactFlowInstance) {
        return
      }
      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()
      if (!reactFlowBounds) {
        return
      }
      const position = reactFlowInstance.project({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      })
      setCursorPosition(position)
    },
    [reactFlowInstance, setCursorPosition]
  )

  useEffect(() => {
    if (fitViewCounter > 0) {
      reactFlowInstance?.fitView({ maxZoom: 1, padding: 0.2 })
    }
  }, [fitViewCounter, reactFlowInstance])

  return (
    <BindLogic logic={diagramLogic} props={diagramLogicProps}>
      <div
        className="w-full h-full dndflow"
        ref={reactFlowWrapper}
        onContextMenu={onContextMenu}
        onMouseMove={onMouseMove}
      >
        <ReactFlow
          nodes={nodesWithStyle}
          edges={highlightedEdges}
          onInit={setReactFlowInstance}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onWheel={onWheel}
          panActivationKeyCode={null}
          minZoom={0.05}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={['Backspace', 'Delete']}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          selectionMode={SelectionMode.Partial}
        >
          <Background
            id="1"
            gap={28}
            size={theme === 'dark' ? 1.1 : 1.35}
            color={theme === 'dark' ? 'rgba(148, 163, 184, 0.18)' : 'rgba(100, 116, 139, 0.24)'}
            variant={BackgroundVariant.Dots}
          />
          {isCompiledScene ? (
            <div className="absolute top-1 left-1 z-10">
              <CompiledSceneTag />
            </div>
          ) : null}
          {showToolbar ? (
            <div className="absolute top-1 right-1 z-10">
              <DiagramToolbar sceneId={sceneId} />
            </div>
          ) : null}
        </ReactFlow>
      </div>
      {newNodePicker && <NewNodePicker />}
    </BindLogic>
  )
}

export function Diagram({ sceneId, showToolbar }: DiagramProps) {
  return (
    <ReactFlowProvider>
      <Diagram_ sceneId={sceneId} showToolbar={showToolbar} />
    </ReactFlowProvider>
  )
}
Diagram.PanelTitle = function DiagramPanelTitle({ sceneId }: DiagramProps) {
  const { frameId } = useValues(frameLogic)
  const diagramLogicProps: DiagramLogicProps = { frameId, sceneId }
  const { hasChanges, sceneName } = useValues(diagramLogic(diagramLogicProps))

  return (
    <>
      {hasChanges ? '* ' : ''}
      {sceneName}
    </>
  )
}
