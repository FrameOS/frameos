import * as ReactJsonImport from '@microlink/react-json-view'
import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'

const reactJsonModule = ReactJsonImport as any
const ReactJsonComponent: any =
  (typeof reactJsonModule === 'function' && reactJsonModule) ||
  (typeof reactJsonModule?.default === 'function' && reactJsonModule.default) ||
  (typeof reactJsonModule?.default?.default === 'function' && reactJsonModule.default.default) ||
  null

export function Debug() {
  const { frameForm } = useValues(frameLogic)
  const { setFrameFormValue } = useActions(frameLogic)
  const setValue = (value: any) => {
    setFrameFormValue('scenes', value)
  }

  if (!ReactJsonComponent) {
    return <div className="p-4 text-sm text-red-300">Unable to load JSON debug viewer on this build.</div>
  }

  return (
    <ReactJsonComponent
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
