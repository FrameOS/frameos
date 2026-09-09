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
  const trimmedName = name.trim()
  const otherNames = ((node.data as { codeArgs?: CodeArg[] }).codeArgs ?? [])
    .map((arg) => arg.name)
    .filter((existing) => existing !== codeArg.name)
  // An argument needs a name the code can reference, and two arguments with
  // one name would share a `codeField/<name>` handle and overwrite each other.
  const nameError = !trimmedName
    ? 'The field needs a name'
    : otherNames.includes(trimmedName)
    ? `"${trimmedName}" is already an argument of this node`
    : null
  const changed = type !== codeArg.type || trimmedName !== codeArg.name
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
            {nameError ? <div className="text-xs text-red-400">{nameError}</div> : null}
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
              color={changed && !nameError ? 'primary' : 'secondary'}
              size="small"
              disabled={!!nameError}
              onClick={() => {
                if (!nameError) {
                  onChange?.({ name: trimmedName, type })
                }
              }}
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
