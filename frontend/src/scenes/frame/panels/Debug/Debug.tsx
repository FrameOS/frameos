import ReactJson from '@microlink/react-json-view'
import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'

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
      onEdit={({ updated_src }) => setValue(updated_src)}
      onAdd={({ updated_src }) => setValue(updated_src)}
      onDelete={({ updated_src }) => setValue(updated_src)}
    />
  )
}
