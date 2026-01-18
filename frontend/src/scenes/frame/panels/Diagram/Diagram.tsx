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
  useRef,
  useState,
} from 'react'
import { AppNode } from './AppNode'
import { CodeNode } from './CodeNode'
import { EventNode } from './EventNode'
import { StateNode } from './StateNode'
import { Button, buttonColor, buttonSize } from '../../../../components/Button'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { NodeType, EdgeType, CodeNodeData } from '../../../../types'
import { AdjustmentsHorizontalIcon, ArrowsPointingInIcon, EyeIcon } from '@heroicons/react/24/outline'
import { Tooltip } from '../../../../components/Tooltip'
import { SceneSettings } from '../Scenes/SceneSettings'
import { ZoomOutArea } from '../../../../icons/ZoomOutArea'
import clsx from 'clsx'
import { CodeNodeEdge } from './CodeNodeEdge'
import { SceneDropDown } from '../Scenes/SceneDropDown'
import { AppNodeEdge } from './AppNodeEdge'
import { NewNodePicker } from './NewNodePicker'
import { CANVAS_NODE_ID, getNewFieldName, newNodePickerLogic } from './newNodePickerLogic'
import { scenesLogic } from '../Scenes/scenesLogic'

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
}

interface ConnectingNode {
  nodeId: string | null
  handleType: string | null
  handleId: string | null
}

function Diagram_({ sceneId }: DiagramProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { frameId } = useValues(frameLogic)
  const updateNodeInternals = useUpdateNodeInternals()
  const diagramLogicProps: DiagramLogicProps = { frameId, sceneId, updateNodeInternals }
  const { nodes, nodesWithStyle, edges, fitViewCounter } = useValues(diagramLogic(diagramLogicProps))
  const {
    onEdgesChange,
    onNodesChange,
    setNodes,
    addEdge,
    fitDiagramView,
    keywordDropped,
    rearrangeCurrentScene,
    setCursorPosition,
  } = useActions(diagramLogic(diagramLogicProps))
  const { previewScene } = useActions(scenesLogic({ frameId }))
  const { unsavedSceneIds, undeployedSceneIds, previewingSceneId } = useValues(scenesLogic({ frameId }))
  const { newNodePicker } = useValues(newNodePickerLogic(diagramLogicProps))
  const { openNewNodePicker } = useActions(newNodePickerLogic(diagramLogicProps))
  const sceneHasChanges = unsavedSceneIds.has(sceneId) || undeployedSceneIds.has(sceneId)
  const isPreviewing = previewingSceneId === sceneId
  const previewTitle = isPreviewing
    ? 'Previewing scene on the frame'
    : sceneHasChanges
    ? 'Preview unsaved changes on the frame'
    : 'No unsaved changes to preview'

  const onDragOver = useCallback((event: any) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: any) => {
      event.preventDefault()
      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()
      const { keyword, type } = JSON.parse(event.dataTransfer.getData('application/reactflow') ?? '{}')
      if (typeof keyword === 'string') {
        const position = reactFlowInstance?.project({
          x: event.clientX - (reactFlowBounds?.left ?? 0),
          y: event.clientY - (reactFlowBounds?.top ?? 0),
        }) ?? { x: 0, y: 0 }
        keywordDropped(keyword, type, position)
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
          edges={edges}
          onInit={setReactFlowInstance}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onWheel={onWheel}
          minZoom={0.2}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={['Backspace', 'Delete']}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          selectionMode={SelectionMode.Partial}
        >
          <Background id="1" gap={24} color="#cccccc" variant={BackgroundVariant.Dots} />
          <div className="absolute top-1 right-1 z-10 flex gap-2">
            <Button
              size="tiny"
              onClick={() => previewScene(sceneId)}
              title={previewTitle}
              color="secondary"
              disabled={!sceneHasChanges || isPreviewing}
            >
              <EyeIcon className="w-5 h-5" />
            </Button>
            <Button size="tiny" onClick={fitDiagramView} title="Fit to View" color="secondary">
              <ZoomOutArea className="w-5 h-5" />
            </Button>
            <Button size="tiny" onClick={rearrangeCurrentScene} title="Realign nodes" color="secondary">
              <ArrowsPointingInIcon className="w-5 h-5" />
            </Button>
            <Tooltip
              tooltipColor="gray"
              className={clsx(buttonSize('tiny'), buttonColor('secondary'))}
              title={<SceneSettings sceneId={sceneId} />}
            >
              <AdjustmentsHorizontalIcon className="w-5 h-5" />
            </Tooltip>
            <SceneDropDown sceneId={sceneId} context="editDiagram" />
          </div>
        </ReactFlow>
      </div>
      {newNodePicker && <NewNodePicker />}
    </BindLogic>
  )
}

export function Diagram({ sceneId }: DiagramProps) {
  return (
    <ReactFlowProvider>
      <Diagram_ sceneId={sceneId} />
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
