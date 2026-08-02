import { BindLogic, useActions, useValues } from 'kea'
import { NodeProps, Handle, Position, NodeResizer, useUpdateNodeInternals } from 'reactflow'
import { useEffect, useId, useRef, useState } from 'react'
import type { CodeNodeData } from '../../../../types'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import { TextArea } from '../../../../components/TextArea'
import Editor, { Monaco } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { CheckIcon, ClipboardDocumentIcon, DocumentDuplicateIcon, TrashIcon } from '@heroicons/react/24/solid'
import { appNodeLogic } from './appNodeLogic'
import { NodeCache } from './NodeCache'
import { CodeArg } from './CodeArg'
import { newNodePickerLogic } from './newNodePickerLogic'
import { NodeZoomLabel } from './NodeZoomLabel'
import { workspaceLogic } from '../../../workspace/workspaceLogic'
import {
  registerCodeNodeArgs,
  setActiveCodeNode,
  unregisterCodeNodeArgs,
} from '../../../../utils/codeNodeTypeDeclarations'

export function CodeNode({ id, isConnectable }: NodeProps<CodeNodeData>): JSX.Element {
  const updateNodeInternals = useUpdateNodeInternals()
  const { frameId, sceneId } = useValues(diagramLogic)
  const { theme } = useValues(workspaceLogic)
  const { updateNodeData, updateEdge, copyAppJSON, duplicateNode, deleteApp } = useActions(diagramLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { isSelected, node, nodeEdges, codeNodeLanguage, runtimeNodeError } = useValues(appNodeLogic(appNodeLogicProps))
  const data: CodeNodeData = (node?.data as CodeNodeData) ?? ({ code: '' } satisfies CodeNodeData)
  const { select, editCodeField } = useActions(appNodeLogic(appNodeLogicProps))
  const { openNewNodePicker } = useActions(newNodePickerLogic({ sceneId, frameId }))
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  // State, not a ref: the declarations effect below has to re-run once the
  // editor hands us its monaco instance.
  const [monaco, setMonaco] = useState<Monaco | null>(null)
  const isSelectedRef = useRef<boolean>(isSelected)
  // Identifies this mounted editor in the shared declaration registry.
  const instanceKey = useId()

  useEffect(() => {
    isSelectedRef.current = isSelected
    if (editorRef.current) {
      updateWheelHandling(editorRef.current)
    }
  }, [isSelected])

  // The diagram publishes one shared .d.ts for all its code nodes (see
  // utils/codeNodeTypeDeclarations): re-registering here on every codeArgs
  // change is what makes a field's type switch reach Monaco live.
  useEffect(() => {
    if (!monaco) {
      return
    }
    registerCodeNodeArgs(monaco, instanceKey, id, data.codeArgs ?? [])
  }, [monaco, instanceKey, id, data.codeArgs])

  // Clicking a node is enough to want its types to win the name collisions it
  // shares with the nodes it is wired to; focusing its editor doubly so.
  useEffect(() => {
    if (monaco && isSelected) {
      setActiveCodeNode(id)
    }
  }, [monaco, isSelected, id])

  useEffect(() => {
    return () => {
      unregisterCodeNodeArgs(instanceKey)
    }
  }, [instanceKey])

  function beforeMount(monaco: Monaco): void {
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      allowJs: true,
      allowNonTsExtensions: true,
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      jsx: monaco.languages.typescript.JsxEmit.Preserve,
    })
    monaco.editor.defineTheme('darkframe-node', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#18181b' },
    })
    monaco.editor.defineTheme('lightframe-node', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#f8fafc' },
    })
  }

  const baseScrollbarOptions = {
    verticalScrollbarSize: 6,
    horizontalScrollbarSize: 6,
    alwaysConsumeMouseWheel: false,
    handleMouseWheel: false,
  }

  const updateWheelHandling = (editor: MonacoEditor.IStandaloneCodeEditor): void => {
    const focused = editor.hasTextFocus()
    editor.updateOptions({
      scrollbar: {
        ...baseScrollbarOptions,
        handleMouseWheel: isSelectedRef.current || focused,
      },
    })
  }

  function handleEditorMount(editor: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco): void {
    editorRef.current = editor
    updateWheelHandling(editor)
    editor.onDidFocusEditorWidget(() => {
      updateWheelHandling(editor)
      setActiveCodeNode(id)
    })
    editor.onDidBlurEditorWidget(() => updateWheelHandling(editor))
    registerCodeNodeArgs(monaco, instanceKey, id, data.codeArgs ?? [])
    setMonaco(monaco)
  }

  const titleBackground = isSelected ? 'frameos-diagram-title-selected' : 'bg-green-900'
  const outputLabel = data.codeOutputs?.find((output) => output.name.trim())?.name ?? 'output'
  const runtimeErrorTitle = runtimeNodeError ? `${runtimeNodeError.event}: ${runtimeNodeError.message}` : undefined
  const runtimeErrorClassName = runtimeNodeError ? 'border-red-500 shadow-red-500/80 ring-2 ring-red-500/70' : null

  return (
    <BindLogic logic={appNodeLogic} props={appNodeLogicProps}>
      <div
        onClick={select}
        title={runtimeErrorTitle}
        className={clsx(
          'shadow-lg border-2 h-full flex flex-col relative',
          isSelected
            ? 'frameos-diagram-node frameos-diagram-node-selected'
            : 'frameos-diagram-node border-green-900 shadow-green-700/50 ',
          runtimeErrorClassName
        )}
      >
        <NodeResizer minWidth={200} minHeight={119} />
        <div className={clsx('flex w-full items-center justify-between', titleBackground)}>
          <div className={clsx('frameos-node-title text-xl px-1 gap-2', 'flex w-full items-center')}>
            {[...(data.codeArgs ?? []), '+'].map((codeField, i) => (
              <div key={i} className="flex gap-1 items-center">
                <Handle
                  // CodeInputHandle
                  type="target"
                  position={Position.Top}
                  id={`codeField/${typeof codeField === 'object' ? codeField.name : codeField}`}
                  style={{
                    position: 'relative',
                    transform: 'none',
                    left: 0,
                    top: 0,
                    background: 'black',
                    borderColor: 'white',
                  }}
                  isConnectable={isConnectable}
                  onClick={(e) => {
                    e.stopPropagation()
                    const existingNodeCount = nodeEdges.filter(
                      (edge) => edge.targetHandle?.startsWith('codeField/') && edge.target === id
                    ).length
                    openNewNodePicker(
                      e.clientX, // screenX
                      e.clientY, // screenY
                      (node?.position.x || 0) - existingNodeCount * 20, // diagramX
                      (node?.position.y || 0) - 40 - existingNodeCount * 150, // diagramY
                      id, // nodeId
                      `codeField/${typeof codeField === 'object' ? codeField.name : codeField}`, // handleId
                      'target' // handleType
                    )
                  }}
                />
                {codeField === '+' ? (
                  <em
                    onClick={(e) => {
                      e.stopPropagation()
                      const existingNodeCount = nodeEdges.filter(
                        (edge) => edge.targetHandle?.startsWith('codeField/') && edge.target === id
                      ).length
                      openNewNodePicker(
                        e.clientX, // screenX
                        e.clientY, // screenY
                        (node?.position.x || 0) - existingNodeCount * 20, // diagramX
                        (node?.position.y || 0) - 40 - existingNodeCount * 150, // diagramY
                        id, // nodeId
                        `codeField/+`, // handleId
                        'target' // handleType
                      )
                    }}
                  >
                    +
                  </em>
                ) : typeof codeField !== 'string' ? (
                  <div className="cursor-pointer hover:underline">
                    <CodeArg
                      key={`${codeField.type}/${codeField.name}`}
                      codeArg={codeField}
                      onChange={(value) => {
                        updateNodeData(id, {
                          codeArgs: data.codeArgs?.map((c, j) => (i === j ? { ...c, ...value } : c)),
                        })
                        nodeEdges.forEach((edge) => {
                          if (edge.target === id && edge.targetHandle === `codeField/${codeField.name}`) {
                            updateEdge({ ...edge, targetHandle: `codeField/${value.name}` })
                          }
                        })
                        updateNodeInternals(id)
                      }}
                      onDelete={() => editCodeField(codeField.name, '')}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <DropdownMenu
            className="w-fit"
            buttonColor="none"
            horizontal
            items={[
              {
                label: 'Copy as JSON',
                onClick: () => copyAppJSON(id),
                icon: <ClipboardDocumentIcon className="w-5 h-5" />,
              },
              {
                label: 'Duplicate',
                onClick: () => duplicateNode(id),
                icon: <DocumentDuplicateIcon className="w-5 h-5" />,
              },
              {
                label: 'Delete Node',
                onClick: () => deleteApp(id),
                icon: <TrashIcon className="w-5 h-5" />,
              },
              {
                label: `Log output (${data.logOutput ? 'enabled' : 'disabled'})`,
                keepOpen: true,
                onClick: () => updateNodeData(id, { logOutput: !(data.logOutput ?? false) }),
                icon: <CheckIcon className={clsx('w-5 h-5', data.logOutput ? 'opacity-100' : 'opacity-0')} />,
              },
            ]}
          />
        </div>
        <div
          className="p-1 flex-1 min-h-0 min-w-0 nodrag nopan"
          data-editable="true"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onCopy={(e) => e.stopPropagation()}
          onPaste={(e) => e.stopPropagation()}
        >
          {codeNodeLanguage === 'js' ? (
            <Editor
              height="100%"
              language="typescript"
              path={`inmemory://code-node/${id}.tsx`}
              value={data.codeJS ?? ''}
              theme={theme === 'dark' ? 'darkframe-node' : 'lightframe-node'}
              beforeMount={beforeMount}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: 'off',
                lineDecorationsWidth: 0,
                glyphMargin: false,
                folding: false,
                renderLineHighlight: 'none',
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                scrollbar: {
                  verticalScrollbarSize: 6,
                  horizontalScrollbarSize: 6,
                  alwaysConsumeMouseWheel: false,
                  handleMouseWheel: false,
                },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
              }}
              onMount={(editor, monaco) => handleEditorMount(editor, monaco)}
              onChange={(value) => updateNodeData(id, { codeJS: value ?? '' })}
            />
          ) : (
            <TextArea
              theme="node"
              className="w-full h-full font-mono resize-none"
              placeholder={data.codeJS ? 'Rewrite to Nim: ' + data.codeJS : `e.g: state{"magic3"}.getStr()`}
              value={data.code ?? ''}
              rows={2}
              onChange={(value) => updateNodeData(id, { code: value.replaceAll('\n', '') })}
            />
          )}
        </div>
        <div
          className={clsx(
            'frameos-node-title text-xl px-1 py-0.5 gap-1',
            isSelected ? 'frameos-diagram-title-selected' : 'bg-green-900',
            'flex w-full justify-between items-center'
          )}
        >
          <div className="flex gap-1 items-center">
            <Handle
              // CodeOutputHandle
              type="source"
              position={Position.Bottom}
              id={`fieldOutput`}
              style={{
                position: 'relative',
                transform: 'none',
                left: 0,
                top: 0,
                background: 'black',
                borderColor: 'white',
              }}
              isConnectable={isConnectable}
              onClick={(e) => {
                e.stopPropagation()
                openNewNodePicker(
                  e.clientX, // screenX
                  e.clientY, // screenY
                  (node?.position.x || 0) + Math.random() * 60 - 10, // diagramX
                  (node?.position.y || 0) + (node?.height || 300) + Math.random() * 30 + 20, // diagramY
                  id, // nodeId
                  `fieldOutput`, // handleId
                  'source' // handleType
                )
              }}
            />
            {data.codeOutputs
              ? data.codeOutputs.map((c, i) => (
                  <CodeArg
                    key={`${i}/${c.type}/${c.name}`}
                    codeArg={c}
                    onChange={(value) => {
                      updateNodeData(id, {
                        codeOutputs: data.codeOutputs?.map((c, j) => (i === j ? { ...c, ...value } : c)),
                      })
                    }}
                  />
                ))
              : null}
          </div>
          <div className="flex gap-1 items-center">
            <NodeCache nodeType="code" />
          </div>
        </div>
        <NodeZoomLabel label={outputLabel} backgroundClassName={titleBackground} />
      </div>
    </BindLogic>
  )
}
