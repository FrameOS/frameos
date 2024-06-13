import { useActions, useValues } from 'kea'
import { AppNodeData, CacheConfig, CodeNodeData } from '../../../../types'
import { Select } from '../../../../components/Select'
import { Label } from '../../../../components/Label'
import { TextInput } from '../../../../components/TextInput'
import { appNodeLogic } from './appNodeLogic'
import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'
import { isNumericString } from '../../../../utils/isNumericString'
import { showAsFps } from '../../../../decorators/refreshInterval'

export function NodeCache(): JSX.Element {
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
              options={[
                { value: 'none', label: 'No cache (compute every time)' },
                { value: 'forever', label: 'Cache forever (till a restart)' },
                { value: 'key', label: 'Cache until a key changes' },
                { value: 'duration', label: 'Cache for a duration' },
                { value: 'keyDuration', label: 'Cache for a duration + key' },
              ]}
              onChange={(value) =>
                updateNodeData(node.id, {
                  cache: {
                    type: value as any,
                    ...(value === 'duration' || value === 'keyDuration' ? { duration: '60' } : {}),
                    ...(value === 'key' || value === 'keyDuration' ? { key: '"string"' } : {}),
                  } satisfies CacheConfig,
                })
              }
            />
          </div>
          {(data.cache?.type === 'duration' || data.cache?.type === 'keyDuration') && (
            <div className="space-y-1">
              <Label>Cache duration in seconds (nim code, return a number)</Label>
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
                <Label>Data type of cache key</Label>
                <Select
                  value={data.cache?.keyDataType ?? 'string'}
                  options={[
                    { value: 'string', label: 'string' },
                    { value: 'integer', label: 'integer' },
                    { value: 'float', label: 'float' },
                    { value: 'json', label: 'json' },
                  ]}
                  onChange={(value) =>
                    updateNodeData(node.id, {
                      cache: { ...((node.data as AppNodeData).cache ?? {}), keyDataType: value },
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Cache key (nim code)</Label>
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
          Cache: forever
        </Tag>
      ) : data.cache?.type === 'key' ? (
        <Tag color="red" className="cursor-pointer">
          Cache: key
        </Tag>
      ) : data.cache?.type === 'keyDuration' ? (
        <Tag color="red" className="cursor-pointer">
          Cache:{' '}
          {String(
            isNumericString(data.cache?.duration) ? showAsFps(parseFloat(data.cache?.duration as string)) : 'duration'
          )}{' '}
          + key
        </Tag>
      ) : (
        <Tag color="orange" className="cursor-pointer">
          Cache:{' '}
          {String(
            isNumericString(data.cache?.duration) ? showAsFps(parseFloat(data.cache?.duration as string)) : 'duration'
          )}
        </Tag>
      )}
    </Tooltip>
  )
}
