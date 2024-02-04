import { useActions, useValues } from 'kea'
import { A, router } from 'kea-router'
import { NewFrame } from './NewFrame'
import { Frame } from './Frame'
import { framesModel } from '../../models/framesModel'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Header } from '../../components/Header'
import { version } from '../../../../version.json'
import { Button } from '../../components/Button'
import { newFrameForm } from './newFrameForm'
import { H6 } from '../../components/H6'

export function Frames() {
  const { framesList } = useValues(framesModel)
  const { formVisible } = useValues(newFrameForm)
  const { showForm } = useActions(newFrameForm)

  return (
    <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute">
      <PanelGroup direction="vertical" units="pixels">
        <Panel minSize={60} maxSize={60}>
          <Header
            title="FrameOS"
            right={
              <div className="flex gap-2 items-center">
                {version}
                <Button color="secondary" onClick={() => router.actions.push('/settings')}>
                  Settings
                </Button>
              </div>
            }
          />
        </Panel>
        <Panel>
          <div className="overflow-auto h-full">
            <div
              id="frames"
              className="p-4 columns-1 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6 gap-4"
            >
              {framesList.map((frame) => (
                <div key={frame.id} className="mb-4">
                  <Frame frame={frame} />
                </div>
              ))}
            </div>
            <div className="p-4">
              {formVisible ? (
                <NewFrame />
              ) : (
                <Button color="secondary" onClick={showForm}>
                  Add a smart frame
                </Button>
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  )
}

export default Frames
