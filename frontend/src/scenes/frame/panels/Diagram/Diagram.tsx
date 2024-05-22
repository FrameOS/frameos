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
import { v4 as uuidv4 } from 'uuid'
import { DiagramNode, NodeType, EdgeType, CodeNodeData } from '../../../../types'
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline'
import { Tooltip } from '../../../../components/Tooltip'
import { SceneSettings } from '../Scenes/SceneSettings'
import { ZoomOutArea } from '../../../../icons/ZoomOutArea'
import clsx from 'clsx'
import CustomEdge from './CustomEdge'
import { SceneDropDown } from '../Scenes/SceneDropDown'

const nodeTypes: Record<NodeType, (props: NodeProps) => JSX.Element> = {
  app: AppNode,
  source: AppNode,
  dispatch: AppNode,
  code: CodeNode,
  event: EventNode,
}

const edgeTypes: Record<EdgeType, (props: EdgeProps) => JSX.Element> = {
  edge: CustomEdge,
}

interface DiagramProps {
  sceneId: string
}
interface ConnectingNode {
  nodeId: string | null
  handleType: string | null
  handleId: string | null
}

function getNewField(codeFields: string[]): string {
  let newField = 'arg'
  let i = 1
  while (codeFields.includes(newField)) {
    newField = `arg${i}`
    i++
  }
  return newField
}

function Diagram_({ sceneId }: DiagramProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { frameId } = useValues(frameLogic)
  const diagramLogicProps: DiagramLogicProps = { frameId, sceneId }
  const { nodes, nodesWithStyle, edges, fitViewCounter } = useValues(diagramLogic(diagramLogicProps))
  const { onEdgesChange, onNodesChange, setNodes, addEdge, fitDiagramView, keywordDropped } = useActions(
    diagramLogic(diagramLogicProps)
  )
  const updateNodeInternals = useUpdateNodeInternals()

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
      const targetIsPane = (event.target as HTMLElement).classList.contains('react-flow__pane')
      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()

      // dropped onto the canvas
      if (targetIsPane) {
        // we only care about code nodes dropped from field inputs and code nodes
        if (
          !(handleType === 'target' && handleId?.startsWith('fieldInput/')) &&
          !(handleType === 'target' && handleId?.startsWith('codeField/'))
        ) {
          return
        }
        event.preventDefault()
        const newNodeId = uuidv4()
        const inputCoords = {
          x: 'clientX' in event ? event.clientX : event.touches[0].clientX,
          y: 'clientY' in event ? event.clientY : event.touches[0].clientY,
        }
        inputCoords.x -= reactFlowBounds?.left ?? 0
        inputCoords.y -= reactFlowBounds?.top ?? 0

        const position = reactFlowInstance?.project(inputCoords) ?? { x: 0, y: 0 }
        position.x -= 20
        position.y -= 120
        const newNode: DiagramNode = {
          id: newNodeId,
          position: position,
          type: 'code',
          data: { code: '', codeFields: [] },
          style: {
            width: 300,
            height: 130,
          },
        }

        if (handleId === 'codeField/+') {
          const codeFields = (nodes.find((node) => node.id === nodeId)?.data as CodeNodeData)?.codeFields ?? []
          let newField = getNewField(codeFields)
          setNodes([
            ...nodes.map((node) =>
              node.id === nodeId ? { ...node, data: { ...node.data, codeFields: [...codeFields, newField] } } : node
            ),
            newNode,
          ])
          window.requestAnimationFrame(() => {
            if (nodeId) {
              updateNodeInternals(nodeId)
            }
            updateNodeInternals(newNodeId)
            addEdge({
              id: uuidv4(),
              target: nodeId,
              targetHandle: `codeField/${newField}`,
              source: newNodeId,
              sourceHandle: 'fieldOutput',
            })
          })
        } else {
          setNodes([...nodes, newNode])
          window.requestAnimationFrame(() => {
            if (nodeId) {
              updateNodeInternals(nodeId)
            }
            updateNodeInternals(newNodeId)
            addEdge({
              id: uuidv4(),
              target: nodeId,
              targetHandle: handleId,
              source: newNodeId,
              sourceHandle: 'fieldOutput',
            })
          })
        }
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
