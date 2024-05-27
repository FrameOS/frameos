import { useActions, useValues } from 'kea'
import { AppNodeData, CodeNodeData } from '../../../../types'
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
                  { value: 'image', label: 'image' },
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
      }
    >
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
          Cache:{' '}
          {String(
            isNumericString(data.cacheDuration) ? showAsFps(parseFloat(data.cacheDuration as string)) : 'duration'
          )}{' '}
          + key
        </Tag>
      ) : (
        <Tag color="orange" className="cursor-pointer">
          Cache:{' '}
          {String(
            isNumericString(data.cacheDuration) ? showAsFps(parseFloat(data.cacheDuration as string)) : 'duration'
          )}
        </Tag>
      )}
    </Tooltip>
  )
}
