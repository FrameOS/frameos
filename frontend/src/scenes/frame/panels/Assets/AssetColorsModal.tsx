import { useActions, useValues } from 'kea'
import type { FrameId } from '../../../../types'
import { assetColorsLogic } from './assetColorsLogic'
import { ColorEditorModal } from './ColorEditorModal'

export function AssetColorsModal({ frameId }: { frameId: FrameId }): JSX.Element | null {
  const logic = assetColorsLogic({ frameId })
  const values = useValues(logic)
  const actions = useActions(logic)
  const fileName = values.imagePath?.split('/').pop() || values.imagePath
  return (
    <ColorEditorModal
      values={values}
      actions={actions}
      hint={
        <>
          The panel's white is darker than a photo's. Pull Whites down, or switch on Auto, to keep texture in bright
          areas instead of flat white. Saved next to the photo as {fileName}.frameos.json.
        </>
      }
    />
  )
}
