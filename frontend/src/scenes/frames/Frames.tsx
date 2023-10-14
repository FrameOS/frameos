import { useValues } from 'kea'
import { NewFrame } from './NewFrame'
import { Frame } from './Frame'
import { framesModel } from '../../models/framesModel'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Header } from '../../components/Header'
// import { version } from '../../../../version.json'

export function Frames() {
  const { framesList } = useValues(framesModel)
  return (
    <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute">
      <PanelGroup direction="vertical" units="pixels">
        <Panel minSize={60} maxSize={60}>
          <Header title="FrameOS" version="1.0.0" />
        </Panel>
        <Panel>
          <div
            id="frames"
            className="max-h-full overflow-auto p-4 columns-1 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6 gap-4"
          >
            {framesList.map((frame) => (
              <div key={frame.id} className="mb-4 break-inside-avoid">
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
