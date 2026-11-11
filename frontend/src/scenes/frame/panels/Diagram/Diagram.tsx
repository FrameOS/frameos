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
  useNodesInitialized,
  useStoreApi,
  ReactFlowProvider,
  SelectionMode,
} from 'reactflow'
import { frameLogic } from '../../frameLogic'
import {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import { AppNode } from './AppNode'
import { CodeNode } from './CodeNode'
import { EventNode } from './EventNode'
import { StateNode } from './StateNode'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { NodeType, EdgeType, CodeNodeData } from '../../../../types'
import { CodeNodeEdge } from './CodeNodeEdge'
import { AppNodeEdge } from './AppNodeEdge'
import { NewNodePicker } from './NewNodePicker'
import { CANVAS_NODE_ID, getNewFieldName, newNodePickerLogic } from './newNodePickerLogic'
import { CompiledSceneTag } from '../Scenes/CompiledSceneTag'
import { workspaceLogic } from '../../../workspace/workspaceLogic'

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

const diagramSelectionDragClassName = 'frameos-diagram-selection-dragging'
const diagramSelectionDragIgnoredSelector =
  'a, button, input, select, textarea, [contenteditable="true"], [contenteditable=""], .monaco-editor'

function setDiagramSelectionDragGuard(active: boolean): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.classList.toggle(diagramSelectionDragClassName, active)
  document.body.classList.toggle(diagramSelectionDragClassName, active)
  if (active) {
    window.getSelection()?.removeAllRanges()
  }
}

function shouldGuardDiagramSelectionDrag(target: HTMLElement | null): boolean {
  if (!target || target.closest(diagramSelectionDragIgnoredSelector)) {
    return false
  }
  return Boolean(target.closest('.react-flow'))
}

function Diagram_({ sceneId }: DiagramProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const selectionDragGuardActive = useRef(false)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  const { frameId } = useValues(frameLogic)
  const { theme } = useValues(workspaceLogic)
  const updateNodeInternals = useUpdateNodeInternals()
  const flowStore = useStoreApi()
  const nodesInitialized = useNodesInitialized()
  const diagramLogicProps: DiagramLogicProps = { frameId, sceneId, updateNodeInternals }
  const { nodes, nodesWithStyle, edges, selectedNodeIds, fitViewCounter, panRequest, isCompiledScene } = useValues(
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

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
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

  const clearSelectionDragGuard = useCallback(() => {
    if (!selectionDragGuardActive.current) {
      return
    }
    selectionDragGuardActive.current = false
    setDiagramSelectionDragGuard(false)
  }, [])

  const onPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.shiftKey) {
      return
    }
    const target = event.target as HTMLElement | null
    if (!shouldGuardDiagramSelectionDrag(target)) {
      return
    }
    selectionDragGuardActive.current = true
    setDiagramSelectionDragGuard(true)
  }, [])

  useEffect(() => {
    const clear = () => clearSelectionDragGuard()
    const clearSelectedText = () => {
      const selection = window.getSelection()
      if (selectionDragGuardActive.current && selection && !selection.isCollapsed) {
        selection.removeAllRanges()
      }
    }
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
    window.addEventListener('mouseup', clear)
    window.addEventListener('blur', clear)
    document.addEventListener('selectionchange', clearSelectedText)
    return () => {
      window.removeEventListener('pointerup', clear)
      window.removeEventListener('pointercancel', clear)
      window.removeEventListener('mouseup', clear)
      window.removeEventListener('blur', clear)
      document.removeEventListener('selectionchange', clearSelectedText)
      setDiagramSelectionDragGuard(false)
    }
  }, [clearSelectionDragGuard])

  // fitView is a no-op (returns false) until reactflow has measured every
  // node, which is later than the diagram's own mount-time requests: a
  // request is kept until nodesInitialized flips, then honoured once. The
  // counter is the logic's; this component outlives a logic when its
  // sceneId changes in place (the embed switching scenes), so what was
  // honoured is remembered per scene — the next scene's counter starts
  // over and must not collide with the last one honoured here.
  const fittedRequestRef = useRef({ sceneId, counter: 0 })
  useEffect(() => {
    if (fittedRequestRef.current.sceneId !== sceneId) {
      fittedRequestRef.current = { sceneId, counter: 0 }
    }
    if (fitViewCounter === 0 || fitViewCounter === fittedRequestRef.current.counter || !reactFlowInstance) {
      return
    }
    if (reactFlowInstance.fitView({ maxZoom: 1, padding: 0.2 })) {
      fittedRequestRef.current.counter = fitViewCounter
    }
  }, [fitViewCounter, nodesInitialized, reactFlowInstance, sceneId])

  // A host's pan (the embedding page keeping the diagram centred while its
  // column resizes): applied once per request, before paint, and never a
  // stale one on a remount — the ref starts at whatever was requested last.
  // Straight through d3-zoom, the way fitView goes: the instance's
  // setViewport runs a (0ms) d3 transition, which only lands on the next
  // animation frame — a frame behind the resize, a visible wobble while
  // a handle is dragged. dx/dy are screen pixels; translateBy takes
  // diagram units, hence the division by the zoom.
  const appliedPanSeqRef = useRef(panRequest?.seq ?? 0)
  useLayoutEffect(() => {
    if (!panRequest || panRequest.seq === appliedPanSeqRef.current) {
      return
    }
    appliedPanSeqRef.current = panRequest.seq
    const { d3Zoom, d3Selection, transform } = flowStore.getState()
    const zoom = transform[2]
    if (d3Zoom && d3Selection && zoom) {
      d3Zoom.translateBy(d3Selection, panRequest.dx / zoom, panRequest.dy / zoom)
    }
  }, [panRequest, flowStore])

  return (
    <BindLogic logic={diagramLogic} props={diagramLogicProps}>
      <div
        className="w-full h-full dndflow"
        ref={reactFlowWrapper}
        onContextMenu={onContextMenu}
        onMouseMove={onMouseMove}
        onPointerDownCapture={onPointerDownCapture}
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
            <div className="absolute top-3 left-2 z-10">
              <CompiledSceneTag frameId={frameId} sceneId={sceneId} />
            </div>
          ) : null}
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
