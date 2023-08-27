import 'reactflow/dist/base.css'
import { useActions, useValues } from 'kea'
import ReactFlow, { Node, ReactFlowInstance } from 'reactflow'
import { frameLogic } from '../../frameLogic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { appsModel } from '../../../../models/appsModel'
import { appConfigWithDefaults } from '../../utils'
import { AppNode } from './AppNode'
import { RenderNode } from './RenderNode'
import { EventNode } from './EventNode'
import { Button } from '../../../../components/Button'

const nodeTypes = {
  app: AppNode,
  render: RenderNode,
  event: EventNode,
}

export function Diagram() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { nodes, edges, fitViewCounter } = useValues(frameLogic)
  const { onEdgesChange, onNodesChange, setNodes, addEdge, rearrangeCurrentScene, fitDiagramView } =
    useActions(frameLogic)

  const onDragOver = useCallback((event: any) => {
    console.log(event)
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: any) => {
      console.log(event)
      event.preventDefault()

      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect()
      const { keyword, type } = JSON.parse(event.dataTransfer.getData('application/reactflow') ?? '{}')

      // check if the dropped element is valid
      if (typeof keyword === 'undefined' || !keyword) {
        return
      }

      const position = reactFlowInstance?.project({
        x: event.clientX - (reactFlowBounds?.left ?? 0),
        y: event.clientY - (reactFlowBounds?.top ?? 0),
      }) ?? { x: 0, y: 0 }

      if (type === 'app') {
        const app = appsModel.values.apps[keyword]
        const newNode: Node = {
          id: String(Math.random()),
          type: 'app',
          position,
          data: { label: app.name || keyword, app: appConfigWithDefaults(keyword, app) },
        }
        setNodes([...nodes, newNode])
      } else if (type === 'event') {
        const newNode: Node = {
          id: String(Math.random()),
          type: 'event',
          position,
          data: { keyword },
        }
        setNodes([...nodes, newNode])
      }

      window.setTimeout(() => reactFlowInstance?.fitView(), 50)
    },
    [reactFlowInstance, nodes]
  )

  useEffect(() => {
    if (fitViewCounter > 0) {
      reactFlowInstance?.fitView()
    }
  }, [fitViewCounter, reactFlowInstance])

  return (
    <div className="w-full h-full dndflow" ref={reactFlowWrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={setReactFlowInstance}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={addEdge}
        onDrop={onDrop}
        onDragOver={onDragOver}
        minZoom={0.2}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        nodeTypes={nodeTypes}
      >
        <div className="absolute top-1 right-1 z-10 space-y-1 w-min">
          <Button size="small" onClick={rearrangeCurrentScene} className="px-2" title="Rearrange (R)">
            R
          </Button>
          <Button size="small" onClick={fitDiagramView} className="px-2" title="Fit to View (F)">
            F
          </Button>
        </div>
      </ReactFlow>
    </div>
  )
}
