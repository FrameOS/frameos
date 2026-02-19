import * as ReactJsonModule from '@microlink/react-json-view'
import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
const ReactJson = ((ReactJsonModule as any).default ?? ReactJsonModule) as any

export function Debug() {
  const { frameForm } = useValues(frameLogic)
  const { setFrameFormValue } = useActions(frameLogic)
  const setValue = (value: any) => {
    setFrameFormValue('scenes', value)
  }
  return (
    <ReactJson
      src={frameForm}
      collapsed={2}
      theme="ocean"
      name="frame"
      style={{ background: 'none' }}
      onEdit={(edit: any) => setValue(edit.updated_src)}
      onAdd={(add: any) => setValue(add.updated_src)}
      onDelete={(del: any) => setValue(del.updated_src)}
    />
  )
}
