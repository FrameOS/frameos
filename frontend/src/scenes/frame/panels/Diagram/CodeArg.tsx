import { TagProps } from '../../../../components/Tag'
import { CodeArg, FieldType, fieldTypes } from '../../../../types'
import { useValues } from 'kea'
import { Select } from '../../../../components/Select'
import { Label } from '../../../../components/Label'
import { TextInput } from '../../../../components/TextInput'
import { appNodeLogic } from './appNodeLogic'
import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'
import { Button } from '../../../../components/Button'
import { useEffect, useState } from 'react'

export interface CodeArgProps {
  codeArg: CodeArg
  onChange?: (codeArg: Partial<CodeArg>) => void
  onDelete?: () => void
}

export const typeColors: Record<FieldType, TagProps['color']> = {
  string: 'blue',
  float: 'red',
  integer: 'orange',
  boolean: 'gray',
  color: 'secondary',
  json: 'secondary',
  node: 'secondary',
  scene: 'secondary',
  image: 'primary',
}

export function CodeArg({ codeArg, onChange }: CodeArgProps): JSX.Element {
  const [name, setName] = useState(codeArg.name ?? '')
  const [type, setType] = useState(codeArg.type ?? 'string')

  useEffect(() => {
    setName(codeArg.name)
    setType(codeArg.type)
  }, [codeArg.name, codeArg.type])

  const { node } = useValues(appNodeLogic)
  if (!node) {
    return <div />
  }
  const codeNode = (
    <>
      {codeArg.name} <Tag color={typeColors[codeArg.type]}>{codeArg.type}</Tag>
    </>
  )

  if (!onChange) {
    return <div>{codeNode}</div>
  }

  return (
    <Tooltip
      tooltipColor="gray"
      title={
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>Field name</Label>
            <TextInput value={name} onChange={(value) => setName(value)} placeholder="name" />
          </div>
          <div className="space-y-1">
            <Label>Data type</Label>
            <Select
              value={type}
              options={fieldTypes.map((t) => ({ value: t, label: t }))}
              onChange={(value) => setType(value as FieldType)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              color={type !== codeArg.type || name !== codeArg.name ? 'primary' : 'secondary'}
              size="small"
              onClick={() => onChange?.({ name, type })}
            >
              Update
            </Button>
            <Button color="tertiary" size="small" onClick={() => onChange?.({ name, type })}>
              Delete
            </Button>
          </div>
        </div>
      }
    >
      <div className="hover:underline cursor-pointer">{codeNode}</div>
    </Tooltip>
  )
}
