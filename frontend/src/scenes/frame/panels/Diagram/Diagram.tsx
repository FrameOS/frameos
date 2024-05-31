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
} from 'reactflow'
import { frameLogic } from '../../frameLogic'
import {
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { AppNode } from './AppNode'
import { CodeNode } from './CodeNode'
import { EventNode } from './EventNode'
import { Button, buttonColor, buttonSize } from '../../../../components/Button'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { NodeType, EdgeType, CodeNodeData } from '../../../../types'
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline'
import { Tooltip } from '../../../../components/Tooltip'
import { SceneSettings } from '../Scenes/SceneSettings'
import { ZoomOutArea } from '../../../../icons/ZoomOutArea'
import clsx from 'clsx'
import { CodeNodeEdge } from './CodeNodeEdge'
import { SceneDropDown } from '../Scenes/SceneDropDown'
import { AppNodeEdge } from './AppNodeEdge'
import { NewNodePicker } from './NewNodePicker'
import { getNewField, newNodePickerLogic } from './newNodePickerLogic'

const nodeTypes: Record<NodeType, (props: NodeProps) => JSX.Element> = {
  app: AppNode,
  source: AppNode,
  dispatch: AppNode,
  code: CodeNode,
  event: EventNode,
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
  const { onEdgesChange, onNodesChange, setNodes, addEdge, fitDiagramView, keywordDropped } = useActions(
    diagramLogic(diagramLogicProps)
  )
  const { newNodePicker } = useValues(newNodePickerLogic(diagramLogicProps))
  const { openNewNodePicker } = useActions(newNodePickerLogic(diagramLogicProps))

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
        const codeFields = (nodes.find((node) => node.id === nodeId)?.data as CodeNodeData)?.codeFields ?? []
        let newField = getNewField(codeFields)
        setNodes(
          nodes.map((node) =>
            node.id === nodeId ? { ...node, data: { ...node.data, codeFields: [...codeFields, newField] } } : node
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

      if (targetIsDiagramCanvas) {
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

  useEffect(() => {
    if (fitViewCounter > 0) {
      reactFlowInstance?.fitView({ maxZoom: 1 })
    }
  }, [fitViewCounter, reactFlowInstance])

  return (
    <BindLogic logic={diagramLogic} props={diagramLogicProps}>
      <div className="w-full h-full dndflow" ref={reactFlowWrapper}>
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
          minZoom={0.2}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
        >
          <Background id="1" gap={24} color="#cccccc" variant={BackgroundVariant.Dots} />
          <div className="absolute top-1 right-1 z-10 flex gap-2">
            <Button size="tiny" onClick={fitDiagramView} title="Fit to View" color="secondary">
              <ZoomOutArea className="w-5 h-5" />
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
