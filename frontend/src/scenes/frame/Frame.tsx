import { BindLogic, useActions, useValues } from 'kea'
import { frameLogic } from './frameLogic'
import { frameHost } from '../../decorators/frame'
import { Panel, PanelGroup } from 'react-resizable-panels'
import { Spinner } from '../../components/Spinner'
import { Button } from '../../components/Button'
import { framesModel } from '../../models/framesModel'
import { Header } from '../../components/Header'
import { Container } from '../../components/panels/Container'
import { Tab } from '../../components/panels/Tab'
import { Tabs } from '../../components/panels/Tabs'
import { Handle } from '../../components/panels/Handle'
import { Area, PanelWithMetadata } from '../../types'
import { panels } from './panels/panels'

interface FrameSceneProps {
  id: string // taken straight from the URL, thus a string
}

interface PanelAreaProps {
  area: Area
  areaPanels: PanelWithMetadata[]
  setPanel: (area: Area, panel: string) => void
}

export function PanelArea({ area, areaPanels, setPanel }: PanelAreaProps): JSX.Element {
  // Don't look at panel.active directly, as many might have it set
  const activePanel = areaPanels.find((panel) => panel.active) ?? areaPanels.find((panel) => !panel.hidden)
  const Component = activePanel ? panels[activePanel.panel] : null

  return (
    <Container
      header={
        <Tabs>
          {areaPanels
            .filter((panel) => !panel.hidden || panel.active)
            .map((panel) => (
              <Tab key={panel.panel} active={activePanel === panel} onClick={() => setPanel(area, panel.panel)}>
                {panel.label ?? panel.panel}
              </Tab>
            ))}
        </Tabs>
      }
    >
      {Component ? <Component /> : <>Nothing to see here...</>}
    </Container>
  )
}

export function Frame(props: FrameSceneProps) {
  const id = parseInt(props.id)
  const frameLogicProps = { id }
  const { frame, panels } = useValues(frameLogic(frameLogicProps))
  const { setPanel } = useActions(frameLogic(frameLogicProps))
  const { redeployFrame, restartFrame, refreshFrame } = useActions(framesModel)

  const onLayout = (sizes: number[]) => {
    // document.cookie = `react-resizable-panels:layout=${JSON.stringify(sizes)}`;
    console.log(sizes)
  }

  console.log(panels)

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      {frame ? (
        <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute flex flex-col">
          <Header
            title="FrameOS"
            subtitle={!frame ? `Loading frame ${props.id}...` : frameHost(frame)}
            buttons={[
              <Button color="light-gray" type="button" onClick={() => refreshFrame(frame.id)}>
                Refresh
              </Button>,
              <Button color="light-gray" type="button" onClick={() => restartFrame(frame.id)}>
                Restart
              </Button>,
              <Button color="light-gray" type="button" onClick={() => redeployFrame(frame.id)}>
                Redeploy
              </Button>,
            ]}
          />
          <PanelGroup direction="horizontal" onLayout={onLayout} units="percentages" className="flex-1 p-4">
            {panels.TopLeft.length > 0 || panels.BottomLeft.length > 0 ? (
              <Panel>
                <PanelGroup direction="vertical">
                  {panels.TopLeft.length > 0 ? (
                    <Panel defaultSize={60}>
                      <PanelArea area={Area.TopLeft} areaPanels={panels.TopLeft} setPanel={setPanel} />
                    </Panel>
                  ) : null}
                  {panels.TopLeft.length > 0 && panels.BottomLeft.length > 0 ? <Handle direction="vertical" /> : null}
                  {panels.BottomLeft.length > 0 ? (
                    <Panel defaultSize={40}>
                      <PanelArea area={Area.BottomLeft} areaPanels={panels.BottomLeft} setPanel={setPanel} />
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
                <PanelGroup direction="vertical" onLayout={onLayout}>
                  {panels.TopRight.length > 0 ? (
                    <Panel defaultSize={60}>
                      <PanelArea area={Area.TopRight} areaPanels={panels.TopRight} setPanel={setPanel} />
                    </Panel>
                  ) : null}
                  {panels.TopRight.length > 0 && panels.BottomRight.length > 0 ? <Handle direction="vertical" /> : null}
                  {panels.BottomRight.length > 0 ? (
                    <Panel defaultSize={40}>
                      <PanelArea area={Area.BottomRight} areaPanels={panels.BottomRight} setPanel={setPanel} />
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
