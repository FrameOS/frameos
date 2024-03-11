import { H6 } from '../../../../components/H6'
import ReactJson from 'react-json-view'
import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'

export function Debug() {
  const { frame, frameForm } = useValues(frameLogic)
  const { setFrameFormValue } = useActions(frameLogic)
  const setValue = (value: any) => {
    setFrameFormValue('scenes', value)
  }
  return (
    <div className="space-y-2">
      <H6>Scenes</H6>
      <ReactJson
        src={frameForm?.scenes ?? frame.scenes ?? []}
        collapsed={2}
        theme="ocean"
        name="scenes"
        style={{ background: 'none' }}
        onEdit={({ updated_src }) => setValue(updated_src)}
        onAdd={({ updated_src }) => setValue(updated_src)}
        onDelete={({ updated_src }) => setValue(updated_src)}
      />
    </div>
  )
}
