import 'reactflow/dist/base.css'
import { useActions, useValues, BindLogic } from 'kea'
import ReactFlow, {
  Background,
  BackgroundVariant,
  ReactFlowInstance,
  Connection,
  OnConnectStartParams,
} from 'reactflow'
import type { Node } from '@reactflow/core/dist/esm/types/nodes'
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
import { RenderNode } from './RenderNode'
import { EventNode } from './EventNode'
import { Button } from '../../../../components/Button'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { v4 as uuidv4 } from 'uuid'

const nodeTypes = {
  app: AppNode,
  code: CodeNode,
  source: AppNode,
  render: RenderNode,
  event: EventNode,
}

interface DiagramProps {
  sceneId: string
}

export function Diagram({ sceneId }: DiagramProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { frameId } = useValues(frameLogic)
  const diagramLogicProps: DiagramLogicProps = { frameId, sceneId }
  const { nodes, nodesWithStyle, edges, fitViewCounter } = useValues(diagramLogic(diagramLogicProps))
  const { onEdgesChange, onNodesChange, setNodes, addEdge, rearrangeCurrentScene, fitDiagramView, keywordDropped } =
    useActions(diagramLogic(diagramLogicProps))

  const onDragOver = useCallback((event: any) => {
    console.log(event)
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
  const connectingNodeId = useRef<string | null>(null)
  const connectingNodeHandle = useRef<string | null>(null)

  const onConnect = useCallback((connection: Connection) => {
    connectingNodeId.current = null
    connectingNodeHandle.current = null
    addEdge(connection)
  }, [])

  const onConnectStart = useCallback((_: ReactMouseEvent | ReactTouchEvent, params: OnConnectStartParams) => {
    const { nodeId, handleId, handleType } = params
    if (handleType === 'target' && handleId?.startsWith('fieldInput/')) {
      connectingNodeId.current = nodeId
      connectingNodeHandle.current = handleId
    }
  }, [])

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (!connectingNodeId.current) return
      if (!connectingNodeHandle.current) return

      event.preventDefault()

      const targetIsPane = (event.target as HTMLElement).classList.contains('react-flow__pane')
      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()

      if (targetIsPane) {
        const id = uuidv4()
        const inputCoords = {
          x: 'clientX' in event ? event.clientX : event.touches[0].clientX,
          y: 'clientY' in event ? event.clientY : event.touches[0].clientY,
        }
        inputCoords.x -= reactFlowBounds?.left ?? 0
        inputCoords.y -= reactFlowBounds?.top ?? 0
        const position = reactFlowInstance?.project(inputCoords) ?? { x: 0, y: 0 }
        position.x -= 200
        position.y -= 80
        const newNode: Node = {
          id,
          position: position,
          type: 'code',
          data: {},
          style: {
            width: 300,
            height: 130,
          },
        }
        setNodes([...nodes, newNode])
        addEdge({
          id,
          target: connectingNodeId.current,
          targetHandle: connectingNodeHandle.current,
          source: id,
          sourceHandle: 'fieldOutput',
        })
      }
    },
    [reactFlowInstance, nodes, edges]
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
        >
          <Background id="1" gap={24} color="#cccccc" variant={BackgroundVariant.Dots} />
          <div className="absolute top-1 right-1 z-10 flex gap-2">
            <Button size="small" onClick={rearrangeCurrentScene} title="Rearrange (R)" color="gray">
              Rearrange
            </Button>
            <Button size="small" onClick={fitDiagramView} title="Fit to View (F)" color="gray">
              Zoom out
            </Button>
          </div>
        </ReactFlow>
      </div>
    </BindLogic>
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
