import { BindLogic, useActions, useValues } from 'kea'
import { frameLogic } from './frameLogic'
import { frameHost } from '../../decorators/frame'
import { Panel, PanelGroup } from 'react-resizable-panels'
import { Spinner } from '../../components/Spinner'
import { Button } from '../../components/Button'
import { Header } from '../../components/Header'
import { Handle } from '../../components/panels/Handle'
import { Area } from '../../types'
import { PanelArea } from './panels/PanelArea'

interface FrameSceneProps {
  id: string // taken straight from the URL, thus a string
}

export function Frame(props: FrameSceneProps) {
  const id = parseInt(props.id)
  const frameLogicProps = { id }
  const { frame, panelsWithConditions: panels, frameFormChanged } = useValues(frameLogic(frameLogicProps))
  const { setPanel, toggleFullScreenPanel, saveFrame, refreshFrame, restartFrame, redeployFrame } = useActions(
    frameLogic(frameLogicProps)
  )

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      {frame ? (
        <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute flex flex-col">
          <Header
            title="FrameOS"
            subtitle={!frame ? `Loading frame ${props.id}...` : frameHost(frame)}
            buttons={[
              <Button color={frameFormChanged ? 'teal' : 'light-gray'} type="button" onClick={() => saveFrame()}>
                Save
              </Button>,
              <Button color="light-gray" type="button" onClick={() => refreshFrame()}>
                &&nbsp;Refresh
              </Button>,
              <Button color="light-gray" type="button" onClick={() => restartFrame()}>
                &&nbsp;Restart
              </Button>,
              <Button color="light-gray" type="button" onClick={() => redeployFrame()}>
                &&nbsp;Redeploy
              </Button>,
            ]}
          />
          <PanelGroup direction="horizontal" units="percentages" className="flex-1 p-4">
            {panels.TopLeft.length > 0 || panels.BottomLeft.length > 0 ? (
              <Panel>
                <PanelGroup direction="vertical">
                  {panels.TopLeft.length > 0 ? (
                    <Panel defaultSize={60}>
                      <PanelArea
                        area={Area.TopLeft}
                        areaPanels={panels.TopLeft}
                        setPanel={setPanel}
                        toggleFullScreenPanel={toggleFullScreenPanel}
                      />
                    </Panel>
                  ) : null}
                  {panels.TopLeft.length > 0 && panels.BottomLeft.length > 0 ? <Handle direction="vertical" /> : null}
                  {panels.BottomLeft.length > 0 ? (
                    <Panel defaultSize={40}>
                      <PanelArea
                        area={Area.BottomLeft}
                        areaPanels={panels.BottomLeft}
                        setPanel={setPanel}
                        toggleFullScreenPanel={toggleFullScreenPanel}
                      />
                    </Panel>
                  ) : null}
                </PanelGroup>
              </Panel>
            ) : null}
            {(panels.TopLeft.length > 0 || panels.BottomLeft.length > 0) &&
            (panels.TopRight.length > 0 || panels.BottomRight.length > 0) ? (
              <Handle direction="horizontal" />
            ) : null}
            {panels.TopRight.length > 0 || panels.BottomRight.length > 0 ? (
              <Panel defaultSize={33}>
                <PanelGroup direction="vertical">
                  {panels.TopRight.length > 0 ? (
                    <Panel defaultSize={60}>
                      <PanelArea
                        area={Area.TopRight}
                        areaPanels={panels.TopRight}
                        setPanel={setPanel}
                        toggleFullScreenPanel={toggleFullScreenPanel}
                      />
                    </Panel>
                  ) : null}
                  {panels.TopRight.length > 0 && panels.BottomRight.length > 0 ? <Handle direction="vertical" /> : null}
                  {panels.BottomRight.length > 0 ? (
                    <Panel defaultSize={40}>
                      <PanelArea
                        area={Area.BottomRight}
                        areaPanels={panels.BottomRight}
                        setPanel={setPanel}
                        toggleFullScreenPanel={toggleFullScreenPanel}
                      />
                    </Panel>
                  ) : null}
                </PanelGroup>
              </Panel>
            ) : null}
          </PanelGroup>
        </div>
      ) : (
        <div>
          Loading frame ${props.id} <Spinner />
        </div>
      )}
    </BindLogic>
  )
}

export default Frame
