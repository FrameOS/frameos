import { useActions, useValues } from 'kea'
import { frameLogic } from '../frameLogic'
import { Button } from '../../../components/Button'
import { Modal } from '../../../components/Modal'
import { sdCardModalLogic } from './sdCardModalLogic'

export function SDCardModal() {
  const { frameId } = useValues(frameLogic)
  const { showSDCardModal } = useValues(sdCardModalLogic({ frameId }))
  const { closeSDCardModal, buildSDCard } = useActions(sdCardModalLogic({ frameId }))

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
              <Button color="primary" onClick={buildSDCard} className="flex gap-2 items-center">
                <div>Build SD card image</div>
              </Button>
            </div>
          }
        >
          <div className="relative p-6 flex-auto space-y-4">
            <p>
              This will generate an <code>.img</code> for the current frame, with FrameOS precompiled, and all scenes
              and assets included.
            </p>
            <ul>
              <li>SSH enabled</li>
              <li>SSH key</li>
              <li>Password</li>
              <li>Agent enabled</li>
              <li>Hostname</li>
              <li>Platform</li>
              <li>Driver</li>
              <li>Wifi SSID</li>
              <li>Wifi password</li>
            </ul>
            <p>
              <span className="text-orange-500">Please note:</span> We will build the image in the background, and the
              download will start as soon as it's ready. You can follow along in the frame's logs. Please don't close or
              reload this page until the download starts.
            </p>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
