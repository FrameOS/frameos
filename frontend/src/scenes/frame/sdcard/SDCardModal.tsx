import { useActions, useAsyncActions, useValues } from 'kea'
import { frameLogic } from '../frameLogic'
import { Button } from '../../../components/Button'
import { Modal } from '../../../components/Modal'
import { sdCardModalLogic } from './sdCardModalLogic'
import { FrameSettings } from '../panels/FrameSettings/FrameSettings'
import { panelsLogic } from '../panels/panelsLogic'

export function SDCardModal() {
  const { frameId } = useValues(frameLogic)
  const { submitFrameForm } = useAsyncActions(frameLogic)
  const { showSDCardModal } = useValues(sdCardModalLogic({ frameId }))
  const { closeSDCardModal, buildSDCard } = useActions(sdCardModalLogic({ frameId }))
  const { openLogs } = useActions(panelsLogic({ frameId }))

  return (
    <>
      {showSDCardModal ? (
        <Modal
          title={'Build SD card'}
          onClose={closeSDCardModal}
          open={showSDCardModal}
          footer={
            <div className="flex items-top justify-end gap-2 p-6 border-t border-solid border-blueGray-200 rounded-b">
              <Button color="none" onClick={closeSDCardModal}>
                Close
              </Button>
              <Button
                color="primary"
                onClick={async () => {
                  console.log('Submitting frame form...')
                  await submitFrameForm()
                  console.log('Building SD card image...')
                  buildSDCard()
                  openLogs()
                }}
                className="flex gap-2 items-center"
              >
                <div>Save & download SD card .img</div>
              </Button>
            </div>
          }
        >
          <div className="relative p-6 flex-auto space-y-4">
            <p>
              This will generate an <code>.img.zst</code> for the current frame, with FrameOS precompiled, and all
              scenes and fonts included. You may update the frame's settings below.
            </p>
            <p>
              <span className="text-orange-500">Please note:</span> We will build the image in the background, and the
              download will start as soon as it's ready. Please don't close or reload this page until then. You can
              follow along in the frame's logs.
            </p>
            <FrameSettings hideDropdown hideDeploymentMode />
          </div>
        </Modal>
      ) : null}
    </>
  )
}
