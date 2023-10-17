import { useValues } from 'kea'
import { A, router } from 'kea-router'
import { NewFrame } from './NewFrame'
import { Frame } from './Frame'
import { framesModel } from '../../models/framesModel'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Header } from '../../components/Header'
import { version } from '../../../../version.json'
import { Button } from '../../components/Button'

export function Frames() {
  const { framesList } = useValues(framesModel)
  return (
    <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute">
      <PanelGroup direction="vertical" units="pixels">
        <Panel minSize={60} maxSize={60}>
          <Header
            title="FrameOS"
            right={
              <div className="flex gap-2 items-center">
                {version}
                <Button color="light-gray" onClick={() => router.actions.push('/settings')}>
                  Settings
                </Button>
              </div>
            }
          />
        </Panel>
        <Panel>
          <div
            id="frames"
            className="max-h-full overflow-auto p-4 columns-1 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6 gap-4"
          >
            {framesList.map((frame) => (
              <div key={frame.id} className="mb-4">
                <Frame frame={frame} />
              </div>
            ))}
            <div className="mb-4 break-inside-avoid">
              <NewFrame />
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  )
}

export default Frames
