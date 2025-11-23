import { useActions, useAsyncActions, useValues } from 'kea'
import { frameLogic } from '../frameLogic'
import { Button } from '../../../components/Button'
import { Modal } from '../../../components/Modal'
import { sdCardModalLogic } from './sdCardModalLogic'
import { FrameSettings } from '../panels/FrameSettings/FrameSettings'
import { panelsLogic } from '../panels/panelsLogic'
import { luckfoxBuildrootPlatformValues } from '../../../devices'

export function SDCardModal() {
  const { frameId, frame, mode } = useValues(frameLogic)
  const { submitFrameForm } = useAsyncActions(frameLogic)
  const { showSDCardModal } = useValues(sdCardModalLogic({ frameId }))
  const { closeSDCardModal, buildSDCard } = useActions(sdCardModalLogic({ frameId }))
  const { openLogs } = useActions(panelsLogic({ frameId }))
  const isLuckfoxBuildroot =
    mode === 'buildroot' && luckfoxBuildrootPlatformValues.includes(frame?.buildroot?.platform ?? '')

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
                  await submitFrameForm()
                  buildSDCard()
                  openLogs()
                }}
                className="flex gap-2 items-center"
              >
                <div>Save & download SD card image</div>
              </Button>
            </div>
          }
        >
          <div className="relative p-6 flex-auto space-y-4">
            {isLuckfoxBuildroot ? (
              <>
                <p>
                  This will clone the official Luckfox Pico Buildroot repository at commit
                  <code className="ml-1">994243753789e1b40ef91122e8b3688aae8f01b8</code>, run its build script for the
                  selected platform, and prepare the resulting image (or archive) for download.
                </p>
                <p>
                  The generated firmware does not yet include your frame&apos;s scenes. You can deploy scenes after
                  flashing and booting the device.
                </p>
              </>
            ) : (
              <p>
                This will generate an <code>.img.zst</code> for the current frame, with FrameOS precompiled, and all
                scenes and fonts included. You may update the frame&apos;s settings below.
              </p>
            )}
            <p>
              <span className="text-orange-500">Please note:</span> We will build the image in the background, and the
              download will start as soon as it's ready. Please don't close or reload this page until then. You can
              follow along in the frame's logs.
            </p>
            {isLuckfoxBuildroot ? null : <FrameSettings hideDropdown hideDeploymentMode />}
          </div>
        </Modal>
      ) : null}
    </>
  )
}
