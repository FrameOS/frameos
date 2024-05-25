import { BuiltLogic, useActions, useValues } from 'kea'
import { NodeProps, Handle, Position, NodeResizer } from 'reactflow'
import { CodeNodeData } from '../../../../types'
import clsx from 'clsx'
import { diagramLogic } from './diagramLogic'
import { TextArea } from '../../../../components/TextArea'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { ClipboardDocumentIcon, TrashIcon } from '@heroicons/react/24/solid'
import { appNodeLogic } from './appNodeLogic'
import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'
import { buttonColor, buttonSize } from '../../../../components/Button'
import { appNodeLogicType } from './appNodeLogicType'
import { Field } from '../../../../components/Field'
import { NumberTextInput } from '../../../../components/NumberTextInput'
import { Select } from '../../../../components/Select'
import { Label } from '../../../../components/Label'
import { TextInput } from '../../../../components/TextInput'

function isNumericString(value?: string | null): boolean {
  return !!String(value || '').match(/^[0-9]+$/)
}

function CodeNodeCache({ logic }: { logic: BuiltLogic<appNodeLogicType> }): JSX.Element {
  const { updateNodeData } = useActions(logic)
  const { node } = useValues(logic)
  if (!node) {
    return <div />
  }
  const data = (node.data ?? {}) as CodeNodeData

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>How to long to cache?</Label>
        <Select
          value={data.cacheType ?? 'none'}
          options={[
            { value: 'none', label: 'No cache (compute every time)' },
            { value: 'forever', label: 'Cache forever (till a restart)' },
            { value: 'duration', label: 'Cache for seconds' },
            { value: 'key', label: 'Cache until a key changes' },
            { value: 'keyDuration', label: 'Cache seconds + key' },
          ]}
          onChange={(value) =>
            updateNodeData(node.id, {
              cacheType: value,
              ...(value === 'duration' || value === 'keyDuration' ? { cacheDuration: 60 } : {}),
              ...(value === 'key' || value === 'keyDuration' ? { cacheKey: '"string"' } : {}),
            })
          }
        />
      </div>
      {(data.cacheType ?? 'none') !== 'none' && (
        <div className="space-y-1">
          <Label>Data type of cached value</Label>
          <Select
            value={data.cacheDataType ?? 'string'}
            options={[
              { value: 'string', label: 'string' },
              { value: 'integer', label: 'integer' },
              { value: 'float', label: 'float' },
              { value: 'json', label: 'json' },
            ]}
            onChange={(value) => updateNodeData(node.id, { cacheDataType: value })}
          />
        </div>
      )}
      {(data.cacheType === 'duration' || data.cacheType === 'keyDuration') && (
        <div className="space-y-1">
          <Label>Cache duration in seconds (code, return a float)</Label>
          <TextInput
            value={data.cacheDuration}
            onChange={(value) => updateNodeData(node.id, { cacheDuration: value })}
            placeholder="60"
          />
        </div>
      )}
      {(data.cacheType === 'key' || data.cacheType === 'keyDuration') && (
        <>
          <div className="space-y-1">
            <Label>Cache key (code, return a {data.cacheKeyDataType ?? 'string'})</Label>
            <TextInput
              value={data.cacheKey}
              onChange={(value) => updateNodeData(node.id, { cacheKey: value })}
              placeholder='"string"'
            />
          </div>
          <div className="space-y-1">
            <Label>Data type of cache key</Label>
            <Select
              value={data.cacheKeyDataType ?? 'string'}
              options={[
                { value: 'string', label: 'string' },
                { value: 'integer', label: 'integer' },
                { value: 'float', label: 'float' },
                { value: 'json', label: 'json' },
              ]}
              onChange={(value) => updateNodeData(node.id, { cacheKeyDataType: value })}
            />
          </div>
        </>
      )}
    </div>
  )
}

export function CodeNode({ data, id, isConnectable }: NodeProps<CodeNodeData>): JSX.Element {
  const { frameId, sceneId } = useValues(diagramLogic)
  const { updateNodeData, copyAppJSON, deleteApp } = useActions(diagramLogic)
  const appNodeLogicProps = { frameId, sceneId, nodeId: id }
  const { isSelected, codeOutputEdge } = useValues(appNodeLogic(appNodeLogicProps))
  const { select, editCodeField, editCodeFieldOutput } = useActions(appNodeLogic(appNodeLogicProps))

  const targetFunction = codeOutputEdge?.targetHandle?.replace(/^[^\/]+\//, '')

  return (
    <div
      onClick={select}
      className={clsx(
        'shadow-lg border-2 h-full flex flex-col',
        isSelected
          ? 'bg-black bg-opacity-70 border-indigo-900 shadow-indigo-700/50'
          : 'bg-black bg-opacity-70 border-sky-900 shadow-sky-700/50 '
      )}
    >
      <NodeResizer minWidth={200} minHeight={130} />
      <div
        className={clsx(
          'frameos-node-title text-xl p-1 gap-2',
          isSelected ? 'bg-indigo-900' : 'bg-sky-900',
          'flex w-full items-center'
        )}
      >
        {[...(data.codeFields ?? []), '+'].map((codeField) => (
          <div className="flex gap-1 items-center">
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
          isSelected ? 'bg-indigo-900' : 'bg-sky-900',
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
          <Tooltip tooltipColor="gray" title={<CodeNodeCache logic={appNodeLogic(appNodeLogicProps)} />}>
            {(data.cacheType ?? 'none') === 'none' ? (
              <Tag color="teal" className="cursor-pointer">
                No cache
              </Tag>
            ) : data.cacheType === 'forever' ? (
              <Tag color="red" className="cursor-pointer">
                Cache: forever
              </Tag>
            ) : data.cacheType === 'key' ? (
              <Tag color="red" className="cursor-pointer">
                Cache: key
              </Tag>
            ) : data.cacheType === 'keyDuration' ? (
              <Tag color="red" className="cursor-pointer">
                Cache: {String(isNumericString(data.cacheDuration) ? data.cacheDuration + 's' : 'duration')} + key
              </Tag>
            ) : (
              <Tag color="orange" className="cursor-pointer">
                Cache: {String(isNumericString(data.cacheDuration) ? data.cacheDuration + 's' : 'duration')}
              </Tag>
            )}
          </Tooltip>
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
  )
}
