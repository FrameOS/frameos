import { useActions, useValues } from 'kea'
import { AppConfigField, AppNodeData, CacheConfig, CodeNodeData, fieldTypes } from '../../../../types'
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
  const { node, configJson } = useValues(appNodeLogic)
  if (!node) {
    return <div />
  }
  const data = (node.data ?? {}) as CodeNodeData | AppNodeData
  const setValue = (name: string, value: any): void =>
    updateNodeData(node.id, { cache: { ...((node.data as AppNodeData).cache ?? {}), [name]: value } })
  const getValue = (name: string): any =>
    name in (data.cache || {})
      ? (data.cache as any)[name]
      : node.type === 'app'
      ? configJson?.fields?.filter((c): c is AppConfigField => 'name' in c).find((c) => c.name === name)?.value
      : null

  return (
    <Tooltip
      tooltipColor="gray"
      titleClassName="w-max"
      title={
        <div className="space-y-2">
          <Label>
            <div className="space-y-1 flex flex-row gap-1 items-center">
              <input
                type="checkbox"
                checked={!!getValue('enabled')}
                onChange={(e) => setValue('enabled', !!e.target.checked)}
              />
              Cache returned value
            </div>
          </Label>
          {getValue('enabled') ? (
            <>
              <Label>
                <div className="space-y-1 flex flex-row gap-1 items-center">
                  <input
                    type="checkbox"
                    checked={!!getValue('inputEnabled')}
                    onChange={(e) => setValue('inputEnabled', !!e.target.checked)}
                  />
                  Refresh when inputs change
                </div>
              </Label>
              <Label>
                <div className="space-y-1 flex flex-row gap-1 items-center">
                  <input
                    type="checkbox"
                    checked={!!getValue('durationEnabled')}
                    onChange={(e) => setValue('durationEnabled', !!e.target.checked)}
                  />
                  Refresh after a time duration
                </div>
              </Label>
              {getValue('durationEnabled') ? (
                <div className="flex w-full gap-1 pl-4 items-center">
                  <TextInput
                    value={getValue('duration')}
                    className="!w-16"
                    onChange={(value) => setValue('duration', value)}
                    placeholder="60"
                  />
                  seconds
                </div>
              ) : null}
              <Label>
                <div className="space-y-1 flex flex-row gap-1 items-center">
                  <input
                    type="checkbox"
                    checked={!!getValue('expressionEnabled')}
                    onChange={(e) => setValue('expressionEnabled', !!e.target.checked)}
                  />
                  Refresh when an expression changes
                </div>
              </Label>
              {getValue('expressionEnabled') && (
                <div className="pl-4 space-y-2">
                  <div className="space-y-1">
                    <Label>Nim expression</Label>
                    <TextInput
                      value={getValue('expression')}
                      onChange={(value) => setValue('expression', value)}
                      placeholder='"string"'
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Return type of expression</Label>
                    <Select
                      value={getValue('expressionType')}
                      onChange={(value) => setValue('expressionType', value)}
                      options={fieldTypes.map((type) => ({ value: type, label: type }))}
                    />
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      }
    >
      {!data.cache?.enabled ? (
        <Tag color="teal" className="cursor-pointer">
          No cache
        </Tag>
      ) : (
        <Tag color={data.cache?.durationEnabled ? 'red' : 'primary'} className="cursor-pointer">
          {[
            data.cache?.durationEnabled
              ? isNumericString(data.cache?.duration)
                ? showAsFps(parseFloat(data.cache?.duration as string))
                : 'time'
              : '',
            data.cache?.expressionEnabled ? 'expr' : '',
            data.cache?.inputEnabled ? 'inputs' : '',
          ]
            .filter(Boolean)
            .join(', ') || 'Cache: ∞'}
        </Tag>
      )}
    </Tooltip>
  )
}
