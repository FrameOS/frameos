import { useValues } from 'kea'
import { NewFrame } from './NewFrame'
import { Frame } from './Frame'
import { H1 } from '../../components/H1'
import { framesModel } from '../../models/framesModel'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Header } from '../../components/Header'

export function Frames() {
  const { framesList } = useValues(framesModel)
  return (
    <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute">
      <PanelGroup direction="vertical" units="pixels">
        <Panel minSize={60} maxSize={60}>
          <Header title="FrameOS" version="v1.0.0" />
        </Panel>
        <Panel>
          <div
            id="frames"
            className="max-h-full overflow-auto p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
          >
            {framesList.map((frame) => (
              <div key={frame.id}>
                <Frame frame={frame} />
              </div>
            ))}
            <NewFrame />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  )
}

export default Frames
