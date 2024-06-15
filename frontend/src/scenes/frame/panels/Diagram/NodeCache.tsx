import { useActions, useValues } from 'kea'
import { AppNodeData, CacheConfig, CodeNodeData, fieldTypes } from '../../../../types'
import { Select } from '../../../../components/Select'
import { Label } from '../../../../components/Label'
import { TextInput } from '../../../../components/TextInput'
import { appNodeLogic } from './appNodeLogic'
import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'
import { isNumericString } from '../../../../utils/isNumericString'
import { showAsFps } from '../../../../decorators/refreshInterval'

export interface NodeCacheProps {
  nodeType: 'app' | 'code'
}

export function NodeCache({ nodeType }: NodeCacheProps): JSX.Element {
  const { updateNodeData } = useActions(appNodeLogic)
  const { node } = useValues(appNodeLogic)
  if (!node) {
    return <div />
  }
  const data = (node.data ?? {}) as CodeNodeData | AppNodeData

  return (
    <Tooltip
      tooltipColor="gray"
      title={
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>How to long to cache?</Label>
            <Select
              value={data.cache?.type ?? 'none'}
              options={
                [
                  { value: 'none', label: 'No cache (compute every time)' },
                  { value: 'forever', label: 'Cache forever (till a restart)' },
                  {
                    value: 'input',
                    label: `Cache until ${nodeType === 'app' ? 'input fields' : 'input arguments'} change`,
                  },
                  {
                    value: 'inputDuration',
                    label: `Cache until ${
                      nodeType === 'app' ? 'input fields' : 'input arguments'
                    } change or time passes`,
                  },
                  { value: 'duration', label: 'Cache until time passes' },
                  { value: 'key', label: 'Cache until a nim expression changes' },
                  { value: 'keyDuration', label: 'Cache until time passes or expression changes' },
                ] satisfies { value: CacheConfig['type']; label: string }[]
              }
              onChange={(value) =>
                updateNodeData(node.id, {
                  cache: {
                    type: value as any,
                    ...(value === 'duration' || value === 'inputDuration' || value === 'keyDuration'
                      ? { duration: '60' }
                      : {}),
                    ...(value === 'key' || value === 'keyDuration' ? { key: '"string"' } : {}),
                  } satisfies CacheConfig,
                })
              }
            />
          </div>
          {(data.cache?.type === 'duration' ||
            data.cache?.type === 'inputDuration' ||
            data.cache?.type === 'keyDuration') && (
            <div className="space-y-1">
              <Label>Cache duration in seconds</Label>
              <TextInput
                value={data.cache?.duration}
                onChange={(value) =>
                  updateNodeData(node.id, { cache: { ...((node.data as AppNodeData).cache ?? {}), duration: value } })
                }
                placeholder="60"
              />
            </div>
          )}
          {(data.cache?.type === 'key' || data.cache?.type === 'keyDuration') && (
            <>
              <div className="space-y-1">
                <Label>Nim expression</Label>
                <TextInput
                  value={data.cache?.keySource ?? ''}
                  onChange={(value) =>
                    updateNodeData(node.id, {
                      cache: { ...((node.data as AppNodeData).cache ?? {}), keySource: value },
                    })
                  }
                  placeholder='"string"'
                />
              </div>
              <div className="space-y-1">
                <Label>Return type of expression</Label>
                <Select
                  value={data.cache?.keyDataType ?? 'string'}
                  options={fieldTypes.map((type) => ({ value: type, label: type }))}
                  onChange={(value) =>
                    updateNodeData(node.id, {
                      cache: { ...((node.data as AppNodeData).cache ?? {}), keyDataType: value },
                    })
                  }
                />
              </div>
            </>
          )}
        </div>
      }
    >
      {(data.cache?.type ?? 'none') === 'none' ? (
        <Tag color="teal" className="cursor-pointer">
          No cache
        </Tag>
      ) : data.cache?.type === 'forever' ? (
        <Tag color="red" className="cursor-pointer">
          Cache: ∞
        </Tag>
      ) : data.cache?.type === 'key' ? (
        <Tag color="red" className="cursor-pointer">
          Cache: key
        </Tag>
      ) : data.cache?.type === 'input' ? (
        <Tag color="red" className="cursor-pointer">
          Cache: inputs
        </Tag>
      ) : data.cache?.type === 'keyDuration' ? (
        <Tag color="red" className="cursor-pointer">
          {String(
            isNumericString(data.cache?.duration) ? showAsFps(parseFloat(data.cache?.duration as string)) : 'duration'
          )}{' '}
          or expr
        </Tag>
      ) : data.cache?.type === 'inputDuration' ? (
        <Tag color="red" className="cursor-pointer">
          {String(
            isNumericString(data.cache?.duration) ? showAsFps(parseFloat(data.cache?.duration as string)) : 'duration'
          )}{' '}
          or inputs
        </Tag>
      ) : (
        <Tag color="orange" className="cursor-pointer">
          {String(
            isNumericString(data.cache?.duration) ? showAsFps(parseFloat(data.cache?.duration as string)) : 'duration'
          )}
        </Tag>
      )}
    </Tooltip>
  )
}
