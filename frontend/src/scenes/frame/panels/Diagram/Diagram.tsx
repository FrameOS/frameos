import 'reactflow/dist/base.css'
import { useActions, useValues } from 'kea'
import ReactFlow, { Node, ReactFlowInstance } from 'reactflow'
import { frameLogic } from '../../frameLogic'
import { useCallback, useRef, useState } from 'react'
import { appsModel } from '../../../../models/appsModel'
import { appConfigWithDefaults } from '../../utils'
import { AppNode } from './AppNode'
import { RenderNode } from './RenderNode'

const nodeTypes = {
  app: AppNode,
  render: RenderNode,
}

export function Diagram() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { nodes, edges } = useValues(frameLogic)
  const { onEdgesChange, onNodesChange, setNodes, addEdge } = useActions(frameLogic)

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
      const keyword = event.dataTransfer.getData('application/reactflow')

      // check if the dropped element is valid
      if (typeof keyword === 'undefined' || !keyword) {
        return
      }

      const position = reactFlowInstance?.project({
        x: event.clientX - (reactFlowBounds?.left ?? 0),
        y: event.clientY - (reactFlowBounds?.top ?? 0),
      }) ?? { x: 0, y: 0 }
      const app = appsModel.values.apps[keyword]
      console.log({ apps: appsModel.values.apps, app, keyword })
      const newNode: Node = {
        id: String(Math.random()),
        type: 'app',
        position,
        data: { label: app.name || keyword, app: appConfigWithDefaults(keyword, app) },
      }
      setNodes([...nodes, newNode])
      window.setTimeout(() => reactFlowInstance?.fitView(), 50)
    },
    [reactFlowInstance, nodes]
  )

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
        fitView
        fitViewOptions={{ padding: 0.5 }}
        nodeTypes={nodeTypes}
      />
    </div>
  )
}
