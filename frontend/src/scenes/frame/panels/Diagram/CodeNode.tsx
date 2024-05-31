import { BindLogic, useActions, useValues } from 'kea'
import { NodeProps, Handle, Position, NodeResizer } from 'reactflow'
import { CodeNodeData } from '../../../../types'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import { TextArea } from '../../../../components/TextArea'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { ClipboardDocumentIcon, TrashIcon } from '@heroicons/react/24/solid'
import { appNodeLogic } from './appNodeLogic'
import { NodeCache } from './NodeCache'

export function CodeNode({ data, id, isConnectable }: NodeProps<CodeNodeData>): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const { updateNodeData, copyAppJSON, deleteApp } = useActions(diagramLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { isSelected, codeOutputEdge } = useValues(appNodeLogic(appNodeLogicProps))
  const { select, editCodeField, editCodeFieldOutput } = useActions(appNodeLogic(appNodeLogicProps))

  const targetFunction = codeOutputEdge?.targetHandle?.replace(/^[^\/]+\//, '')

  return (
    <BindLogic logic={appNodeLogic} props={appNodeLogicProps}>
      <div
        onClick={select}
        className={clsx(
          'shadow-lg border-2 h-full flex flex-col',
          isSelected
            ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
            : 'bg-black bg-opacity-70 border-green-900 shadow-green-700/50 '
        )}
      >
        <NodeResizer minWidth={200} minHeight={130} />
        <div
          className={clsx(
            'frameos-node-title text-xl p-1 gap-2',
            isSelected ? 'bg-indigo-900' : 'bg-green-900',
            'flex w-full items-center'
          )}
        >
          {[...(data.codeFields ?? []), '+'].map((codeField, i) => (
            <div key={i} className="flex gap-1 items-center">
              <Handle
                type="target"
                position={Position.Top}
                id={`codeField/${codeField}`}
                style={{
                  position: 'relative',
                  transform: 'none',
                  right: 0,
                  top: 0,
                  background: 'black',
                  borderColor: 'white',
                }}
                isConnectable={isConnectable}
              />
              {codeField === '+' ? (
                <em>+</em>
              ) : (
                <div className="cursor-pointer hover:underline" onClick={() => editCodeField(codeField)}>
                  {codeField}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="p-1 h-full">
          <TextArea
            theme="node"
            className="w-full h-full font-mono resize-none"
            placeholder={`e.g: state{"magic3"}.getStr()`}
            value={data.code ?? ''}
            rows={2}
            onChange={(value) => updateNodeData(id, { code: value.replaceAll('\n', '') })}
          />
        </div>
        <div
          className={clsx(
            'frameos-node-title text-xl p-1 gap-1',
            isSelected ? 'bg-indigo-900' : 'bg-green-900',
            'flex w-full justify-between items-center'
          )}
        >
          <div className="flex gap-1 items-center">
            <Handle
              type="source"
              position={Position.Bottom}
              id={`fieldOutput`}
              style={{
                position: 'relative',
                transform: 'none',
                right: 0,
                top: 0,
                background: 'black',
                borderColor: 'white',
              }}
              isConnectable={isConnectable}
            />
            <div
              className={targetFunction ? 'cursor-pointer hover:underline' : ''}
              onClick={targetFunction ? () => editCodeFieldOutput(targetFunction) : undefined}
            >
              {targetFunction ?? <em>disconnected</em>}
            </div>
          </div>
          <div className="flex gap-1 items-center">
            <NodeCache />
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
                  label: 'Delete Node',
                  onClick: () => deleteApp(id),
                  icon: <TrashIcon className="w-5 h-5" />,
                },
              ]}
            />
          </div>
        </div>
      </div>
    </BindLogic>
  )
}
