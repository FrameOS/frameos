import type { CodeArg, FieldType } from '../../../../types'
import { fieldTypes } from '../../../../types'
import { useValues } from 'kea'
import { Select } from '../../../../components/Select'
import { Label } from '../../../../components/Label'
import { TextInput } from '../../../../components/TextInput'
import { appNodeLogic } from './appNodeLogic'
import { Tooltip } from '../../../../components/Tooltip'
import { Button } from '../../../../components/Button'
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { FieldTypeTag } from '../../../../components/FieldTypeTag'

export interface CodeArgProps {
  codeArg: CodeArg
  onChange?: (codeArg: Partial<CodeArg>) => void
  onDelete?: () => void
}

export function CodeArg({ codeArg, onChange, onDelete }: CodeArgProps): JSX.Element {
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
    <div className={clsx('flex items-center gap-1', onChange && 'hover:underline cursor-pointer')}>
      <div>{codeArg.name}</div>
      <FieldTypeTag type={codeArg.type} />
    </div>
  )

  if (!onChange) {
    return codeNode
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
            {onDelete ? (
              <Button color="tertiary" size="small" onClick={() => onDelete?.()}>
                Delete
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      {codeNode}
    </Tooltip>
  )
}
