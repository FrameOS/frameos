import 'reactflow/dist/base.css'
import { useActions, useValues, BindLogic } from 'kea'
import ReactFlow, { Background, BackgroundVariant, ReactFlowInstance } from 'reactflow'
import { frameLogic } from '../../frameLogic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppNode } from './AppNode'
import { RenderNode } from './RenderNode'
import { EventNode } from './EventNode'
import { Button } from '../../../../components/Button'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'

const nodeTypes = {
  app: AppNode,
  source: AppNode,
  render: RenderNode,
  event: EventNode,
}

export function Diagram({ sceneId }: { sceneId: string }) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { id: frameId, frame } = useValues(frameLogic)
  const { setFrameFormValues } = useActions(frameLogic)
  const diagramLogicProps: DiagramLogicProps = {
    frameId,
    sceneId,
    onChange: (nodes, edges) => {
      const hasScene = frame.scenes?.some(({ id }) => id === sceneId)
      setFrameFormValues({
        scenes: hasScene
          ? frame.scenes?.map((scene) => (scene.id === sceneId ? { ...scene, nodes, edges } : scene))
          : [...(frame.scenes ?? []), { id: sceneId, nodes, edges }],
      })
    },
  }
  const { nodes, edges, fitViewCounter } = useValues(diagramLogic(diagramLogicProps))
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

  useEffect(() => {
    if (fitViewCounter > 0) {
      reactFlowInstance?.fitView({ maxZoom: 1 })
    }
  }, [fitViewCounter, reactFlowInstance])

  return (
    <BindLogic logic={diagramLogic} props={diagramLogicProps}>
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
          <Background id="1" gap={24} color="#cccccc" variant={BackgroundVariant.Dots} />
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
    </BindLogic>
  )
}
